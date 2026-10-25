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
    autoAnswer: false,        // 刷课途中遇到作业/测验时是否顺手答题
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
    skipping: false,
    logs: [],
  };

  function log(msg, level) {
    const line = { ts: Date.now(), level: level || "info", msg: String(msg) };
    state.logs.push(line);
    if (state.logs.length > 300) state.logs.shift();
    const fn = level === "error" ? console.warn : console.log;
    fn("[学习通·视频]", msg);
  }

  /**
   * 找 video 元素。
   * 学习页的播放器在**第二层** iframe 里：
   *   studentstudy → #iframe(knowledge/cards) → ananas/modules/video/index.html → video
   * 所以必须递归所有 iframe，只看一层会永远找不到。
   */
  function getVideo() {
    // 1) 当前文档
    try {
      const v = document.querySelector("video");
      if (v) return v;
    } catch (_) {}

    // 2) 递归所有可访问 iframe（含嵌套）
    for (const fr of collectFrames()) {
      let d = null;
      try { d = fr.contentDocument; } catch (_) {}
      if (!d) continue;
      try {
        const inner = d.querySelector("video");
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

  /* ---------------- 任务点类型判定 ---------------- */

  /** 收集所有可访问的 iframe（含嵌套） */
  function collectFrames() {
    const out = [];
    const walk = (doc, depth) => {
      if (depth > 6) return;
      let frames = [];
      try { frames = [...doc.querySelectorAll("iframe")]; } catch (_) {}
      for (const fr of frames) {
        out.push(fr);
        let d = null;
        try { d = fr.contentDocument; } catch (_) {}
        if (d && d.body) walk(d, depth + 1);
      }
    };
    walk(document, 0);
    return out;
  }

  /**
   * 当前任务点类型，取自 ananas/modules/<type>/
   * 实测可能是：video / doc / ppt / work / insertdoc / audio …
   */
  function currentModuleType() {
    const types = [];
    for (const fr of collectFrames()) {
      const m = (fr.src || "").match(/ananas\/modules\/([a-zA-Z0-9_]+)/);
      if (m) types.push(m[1].toLowerCase());
    }
    // 只要存在 video 元素或 video 模块，一律优先当视频处理，
    // 避免外层容器是 work/doc 时把播放页误判成非视频而跳走
    if (types.includes("video") || getVideo()) return "video";
    return types[0] || null;
  }

  function isVideoTask() {
    return currentModuleType() === "video" || !!getVideo();
  }

  /** 播完切下一任务点（会自动跳过 PPT / 文档等非视频） */
  async function onEnded() {
    if (!state.config.autoNext) return;
    log("当前视频已播完，准备切换下一任务点");
    await advance();
  }

  /**
   * 前进到下一个**视频**任务点。
   * 遇到 PPT / 文档 / 图文等非视频任务会自动跳过。
   */
  async function advance() {
    const btn = findNextButton();
    if (!btn) {
      log("已到目录末尾，请核对平台任务完成状态", "warn");
      state.running = false;
      return false;
    }
    try { btn.click(); } catch (_) {}
    await new Promise((r) => setTimeout(r, 2500));
    return await skipToVideo(15);
  }
  function findNextButton() {
    const sels = [
      '[onclick*="nextChapter"]',
      '[onclick*="next"]',
      '.nextChapter',
      '.next_chapter',
      'a[title*="下一"]',
      'span[title*="下一"]',
    ];
    for (const s of sels) {
      const el = document.querySelector(s);
      if (el && el.offsetParent !== null) return el;
    }
    // 目录里当前节点之后的下一个
    const nodes = [...document.querySelectorAll(".posCatalog_select:not(.firstLayer), .posCatalog_name")];
    if (nodes.length) {
      let idx = nodes.findIndex((n) => /select|active|cur/i.test(n.className || ""));
      if (idx < 0) idx = 0;
      if (nodes[idx + 1]) return nodes[idx + 1];
    }
    return null;
  }

  /**
   * 跳过非视频任务点，直到遇到视频。
   * 若开启 autoAnswer，遇到「作业/测验」任务点会先答题再继续。
   * @returns {Promise<boolean>} 是否找到了视频
   */
  async function skipToVideo(maxTries) {
    const limit = maxTries || 15;
    for (let i = 0; i < limit; i++) {
      if (!state.running) return false;
      const type = currentModuleType();
      if (type === "video" || getVideo()) {
        if (i > 0) log("已跳到视频任务点（跳过 " + i + " 个非视频）");
        return true;
      }

      // 作业/测验任务点：按开关决定是否顺便答题
      if (type === "work" || type === "insertdoc" || type === "worknew") {
        if (state.config.autoAnswer) {
          log("遇到「" + type + "」任务点，开始自动答题…");
          await answerCurrentTask();
        } else {
          log("遇到「" + type + "」任务点，未开启自动答题，跳过");
        }
      } else {
        log("当前是「" + (type || "未知") + "」任务点，跳过");
      }

      const btn = findNextButton();
      if (!btn) {
        log("已到目录末尾或找不到下一节", "warn");
        return false;
      }
      try { btn.click(); } catch (_) {}
      await new Promise((r) => setTimeout(r, 2500));
    }
    log("连续跳过 " + limit + " 次仍未遇到视频", "warn");
    return false;
  }

  /** 在当前任务点执行一次答题（复用页面里的答题模块） */
  async function answerCurrentTask() {
    try {
      const legacy = window.CXLegacy && window.CXLegacy.findQuestionDocs().length > 0;
      let modelConfig = null;
      try {
        modelConfig = await new Promise((res) => {
          chrome.runtime.sendMessage({ action: "getActiveModelConfig" }, (r) => {
            if (chrome.runtime.lastError) return res(null);
            res(r && r.config ? r.config : null);
          });
        });
      } catch (_) {}

      let r = null;
      if (legacy) {
        r = await window.CXLegacy.run({ modelConfig, maxQuestions: 40 });
      } else if (window.CXAnswer) {
        r = await window.CXAnswer.run({ modelConfig, autoSubmit: false });
      }
      const st = (r && r.stats) || {};
      log(
        "答题完成：已答 " + (st.answered || 0) +
        "，失败 " + (st.failed || 0) +
        "，跳过 " + (st.skipped || 0)
      );
    } catch (e) {
      log("答题失败：" + e.message, "warn");
    }
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
      // 当前不是视频：自动跳到下一个视频任务点
      if (!state.skipping) {
        state.skipping = true;
        if (!state._noVideoLogged) {
          state._noVideoLogged = true;
          log("当前页面未找到 video 元素，尝试跳到视频任务点…");
        }
        skipToVideo(3).then((ok) => {
          state.skipping = false;
          if (!ok && state.running) {
            log("没有可播放的视频，停止自动刷课", "warn");
            state.running = false;
          }
        });
      }
      return;
    }

    state._noVideoLogged = false;

    // 首次找到播放器时提示一次
    if (!state._videoFound) {
      state._videoFound = true;
      log(
        "已定位播放器：时长 " + (isFinite(video.duration) ? video.duration.toFixed(1) + "s" : "未知") +
        "，当前倍速 " + video.playbackRate + "x"
      );
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
      state.skipping = false;
      state.timer = setInterval(tick, state.config.checkInterval);
      tick();
      log(
        "已启动：倍速 " + state.config.rate + "x，" +
        (state.config.seekToLast ? "跳尾" : "正常播放") +
        (state.config.autoNext ? "，播完自动切换" : "") +
        (state.config.autoAnswer ? "，遇到作业自动答题" : "")
      );
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

  // 把新能力挂到既有 api 上（api.start/stop/status/setRate 是对象方法，不能直接当标识符引用）
  window.CXVideo = Object.assign(api, {
    nextTaskPoint: advance,
    advance,
    skipToVideo,
    answerCurrentTask,
    currentModuleType,
    isVideoTask,
    findNextButton,
  });
})();
