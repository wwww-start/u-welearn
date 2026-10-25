/**
 * 学习通刷视频控制器
 *
 * 能力：
 *   1. 倍速播放（并确认生效）
 *   2. 跳到最后一段（快速刷完，可选）
 *   3. 卡住自动恢复（检测 currentTime 停滞 → play）
 *   4. 播完自动切下一个任务点
 *   5. 屏蔽静音/失焦暂停
 *
 * 与 xuexitong-video-guard.js 的关系：
 *   guard 在 MAIN world 摘掉播放器的 ratechange/seeked/seeking 监听，
 *   本文件在隔离世界负责"操作"，两者配合才能既加速又不被标记。
 */
(function () {
  "use strict";

  // 防重复注入
  if (window.CXVideo) return;
  const DEFAULTS = {
    rate: 2,
    checkInterval: 3000,
    stallThreshold: 8,        // 秒：currentTime 无增长超过该值视为卡住
    resumeCooldown: 6000,     // 毫秒：两次强制恢复最小间隔
    seekToLast: false,        // 是否跳到最后一段
    seekTailSeconds: 5,       // 跳到距结尾多少秒
    autoNext: true,           // 播完自动切下一任务点
    muteWhenHidden: true,     // 隐藏时静音保活
  };

  const state = {
    running: false,
    config: { ...DEFAULTS },
    timer: null,
    lastTime: 0,
    lastMoveAt: 0,
    lastResumeAt: 0,
    applying: false,
    logs: [],
  };

  function log(msg, level) {
    const line = { ts: Date.now(), level: level || "info", msg: String(msg) };
    state.logs.push(line);
    if (state.logs.length > 300) state.logs.shift();
    const fn = level === "error" ? console.warn : console.log;
    fn("[学习通·视频]", msg);
  }

  function getVideo() {
    // 播放器在 iframe 内，优先取当前文档；本脚本 all_frames 未开，需从主文档找 iframe
    let v = document.querySelector("video");
    if (v) return v;
    for (const fr of document.querySelectorAll("iframe")) {
      try {
        const inner = fr.contentDocument && fr.contentDocument.querySelector("video");
        if (inner) return inner;
      } catch (_) {}
    }
    return null;
  }

  /** 应用倍速（带重试，防止播放器初始化后覆盖） */
  function applyRate(video, rate, attempt) {
    if (!video) return;
    attempt = attempt || 0;
    try {
      if (Math.abs((video.playbackRate || 1) - rate) < 0.01) return;
      video.playbackRate = rate;
      if (attempt < 3) {
        setTimeout(() => {
          if (video.playbackRate !== rate) applyRate(video, rate, attempt + 1);
        }, 800);
      }
    } catch (e) {
      log("设置倍速失败：" + e.message, "warn");
    }
  }

  /** 跳到最后一段 */
  function seekTail(video) {
    if (!video || !isFinite(video.duration) || video.duration <= 0) return;
    const target = Math.max(0, video.duration - state.config.seekTailSeconds);
    if (video.currentTime < target - 1) {
      try {
        video.currentTime = target;
        log("已跳至 " + target.toFixed(1) + "s / " + video.duration.toFixed(1) + "s");
      } catch (e) {
        log("跳转失败：" + e.message, "warn");
      }
    }
  }

  /** 保活：暂停 / 静音 / 隐藏时恢复 */
  function keepAlive(video) {
    if (!video) return;
    const now = Date.now();
    if (now - state.lastResumeAt < state.config.resumeCooldown) return;

    if (state.config.muteWhenHidden && document.hidden && !video.muted) {
      video.muted = true;
    }
    if (video.paused) {
      state.lastResumeAt = now;
      video.play().catch((e) => {
        // 自动播放被拦，静音后再试一次
        video.muted = true;
        video.play().catch((err) => log("恢复播放失败：" + err.message, "warn"));
      });
      log("检测到暂停，已尝试恢复播放");
    }
  }

  /** 卡住检测 */
  function checkStall(video) {
    if (!video) return;
    const cur = video.currentTime || 0;
    const now = Date.now();

    if (Math.abs(cur - state.lastTime) > 0.15) {
      state.lastTime = cur;
      state.lastMoveAt = now;
      return;
    }
    const stalledSec = (now - state.lastMoveAt) / 1000;
    if (stalledSec >= state.config.stallThreshold && !video.paused) {
      log("播放停滞 " + stalledSec.toFixed(0) + "s，尝试恢复");
      state.lastMoveAt = now;
      keepAlive(video);
    }
  }

  /** 播完切下一任务点 */
  function onEnded() {
    if (!state.config.autoNext) return;
    log("当前视频已播完，准备切换下一任务点");
    nextTaskPoint();
  }

  /**
   * 切下一个任务点。
   * 依据实测：学习页顶部/左侧 ul.prev_ul > li[onclick^=changeDisplayContent]
   * 以及章节目录 .posCatalog_select / .posCatalog_name
   */
  function nextTaskPoint() {
    // 1) 同章节内还有下一个 tab（1内容/2练习/3案例...）
    const tabs = window.CXModel?.readTaskTabs?.() || [];
    const cardsFrame = document.getElementById("iframe");
    let innerDoc = null;
    try {
      innerDoc = cardsFrame && cardsFrame.contentDocument;
    } catch (_) {}

    // 2) 目录里找下一个节点
    const nodes = [...document.querySelectorAll(".posCatalog_select:not(.firstLayer), .posCatalog_name")];
    if (nodes.length) {
      // 找当前高亮节点
      let curIdx = nodes.findIndex(
        (n) => /select|active|cur/i.test(n.className) || n.getAttribute("aria-current")
      );
      if (curIdx < 0) curIdx = 0;
      const next = nodes[curIdx + 1];
      if (next) {
        log("切换到下一章节节点：" + (next.textContent || "").trim().slice(0, 30));
        next.click();
        return true;
      }
      log("已到目录末尾，请核对平台任务完成状态", "warn");
      return false;
    }

    // 3) 兜底：点目录面板里的"下一节"
    const btn = document.querySelector('[onclick*="next"], .nextChapter, .next_chapter');
    if (btn) {
      btn.click();
      log("点击了下一节按钮");
      return true;
    }
    log("未找到可切换的下一任务点", "warn");
    return false;
  }

  /** 主循环 */
  function tick() {
    if (!state.running) return;
    const video = getVideo();
    if (!video) {
      log("未找到 video 元素，等待加载…", "warn");
      return;
    }

    applyRate(video, state.config.rate);
    if (state.config.seekToLast) seekTail(video);
    keepAlive(video);
    checkStall(video);

    if (!video.__cxEndedBound) {
      video.__cxEndedBound = true;
      video.addEventListener("ended", onEnded);
    }
  }

  const api = {
    start(options) {
      if (state.running) return { ok: true, already: true };
      Object.assign(state.config, options || {});
      state.running = true;
      state.lastTime = 0;
      state.lastMoveAt = Date.now();
      state.timer = setInterval(tick, state.config.checkInterval);
      tick();
      log("已启动：倍速 " + state.config.rate + "x，" +
          (state.config.seekToLast ? "跳尾" : "正常播放") +
          (state.config.autoNext ? "，自动切换" : ""));
      return { ok: true, config: { ...state.config } };
    },
    stop() {
      state.running = false;
      if (state.timer) clearInterval(state.timer);
      state.timer = null;
      log("已停止");
      return { ok: true };
    },
    status() {
      const v = getVideo();
      return {
        running: state.running,
        config: { ...state.config },
        video: v
          ? {
              currentTime: +v.currentTime.toFixed(1),
              duration: +v.duration.toFixed(1),
              rate: v.playbackRate,
              paused: v.paused,
              muted: v.muted,
            }
          : null,
        guardActive: !!window.__CX_VIDEO_GUARD__,
        logs: state.logs.slice(-30),
      };
    },
    setRate(r) {
      state.config.rate = Math.max(0.5, Math.min(16, Number(r) || 1));
      return { ok: true, rate: state.config.rate };
    },
    nextTaskPoint,
    getVideo,
  };

  window.CXVideo = api;
})();
