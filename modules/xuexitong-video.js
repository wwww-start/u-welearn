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

  /* ---------------- 视频内嵌题（播放器里弹出的测验）自动作答 + 提交 ---------------- */

  const quizHandled = new WeakSet();

  /** 在视频所在文档里找"内嵌题"根节点（文本特征：题型 + 共N题/已答对） */
  function findQuizRoot(doc) {
    if (!doc || !doc.body) return null;
    let blocks = [];
    try { blocks = doc.querySelectorAll("div,section,form"); } catch (_) { return null; }
    const hits = [];
    for (const el of blocks) {
      if (!el.offsetParent && el !== doc.body) continue;
      const t = el.textContent || "";
      if (t.length > 4000) continue;
      if (!/(单选题|多选题|判断题)/.test(t)) continue;
      if (!/共\s*\d+\s*题|已答对/.test(t)) continue;
      if (![...el.querySelectorAll("a,button,div,span")].some((x) => /^提交$/.test((x.textContent || "").trim()))) continue;
      hits.push(el);
    }
    if (!hits.length) return null;
    // 取**最内层**（后代最少）的那个，避免把整个播放器外壳当题目容器
    hits.sort((a, b) => a.querySelectorAll("*").length - b.querySelectorAll("*").length);
    return hits[0];
  }

  /** 读题：题干文本 + 选项（A/B/C/D 或 radio/label/li） */
  function readQuiz(root) {
    const out = { stem: "", options: [], submitNode: null, counter: "" };
    const isSubmit = (el) => /^(提交|提交答案|确认提交)$/.test((el.textContent || "").trim());

    // 提交按钮：取最内层、可见的那个
    const submits = [...root.querySelectorAll("a,button,div,span")]
      .filter((el) => isSubmit(el) && (el.offsetParent || el === root));
    out.submitNode = submits.length ? submits[submits.length - 1] : null;

    // 计数器 "共1题，已答对0题"
    const counterEl = [...root.querySelectorAll("span,div,p,i")]
      .find((el) => /共\s*\d+\s*题/.test((el.textContent || "").trim()) && (el.textContent || "").length < 40);
    if (counterEl) out.counter = (counterEl.textContent || "").trim();

    // 选项：优先 radio/checkbox 的可点祖先
    const inputs = [...root.querySelectorAll('input[type="radio"],input[type="checkbox"]')];
    for (const inp of inputs) {
      let node = inp.closest("li,label,div[class],p") || inp;
      // 往上找一层更完整的可点容器
      for (let i = 0; i < 3 && node && node !== root; i++) {
        if ((node.textContent || "").trim().length > 2) break;
        node = node.parentElement;
      }
      const text = (node.textContent || "").trim().replace(/\s+/g, " ");
      if (!text) continue;
      out.options.push({ node, input: inp, text });
    }

    if (!out.options.length) {
      // 没有 input：按 "A. xxx" 文本项抓
      const cands = [...root.querySelectorAll("li,div,p")].filter((el) => {
        const t = (el.textContent || "").trim();
        return /^[A-DＡ-Ｄ][.、．)）\s]/.test(t) && t.length < 300 && el.children.length <= 6;
      });
      for (const el of cands.slice(0, 8)) {
        out.options.push({ node: el, input: null, text: (el.textContent || "").trim().replace(/\s+/g, " ") });
      }
    }

    // 选项编号：命中顺序即 A/B/C/D（超星内嵌题选项是顺序渲染，不随机）
    out.options = out.options.slice(0, 8).map((o, i) => ({ ...o, label: String.fromCharCode(65 + i) }));

    // 题干：整段文本去掉选项后剩下的
    let stem = (root.textContent || "").replace(/\s+/g, " ").trim();
    for (const o of out.options) stem = stem.split(o.text).join(" ");
    stem = stem
      .replace(/(单选题|多选题|判断题)/g, " ")
      .replace(/共\s*\d+\s*题\s*[,，]?\s*(已答对)?\s*\d*\s*题?/g, " ")
      .replace(/回答正确|回答错误|已答对\s*\d+\s*题/g, " ")
      .replace(/提交/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    out.stem = stem.slice(0, 800);
    return out;
  }

  async function getModelConfigCached() {
    return new Promise((res) => {
      try {
        chrome.runtime.sendMessage({ action: "getActiveModelConfig" }, (r) => {
          if (chrome.runtime.lastError) return res(null);
          res(r && r.config ? r.config : null);
        });
      } catch (_) {
        res(null);
      }
    });
  }

  /**
   * 处理视频内嵌题：读题 → 文本模型作答 → 点选项 → 点「提交」。
   * 只在该开关打开（刷课时自动答题）时生效。
   */
  async function handleVideoQuiz(video, force) {
    if (!force && !state.config.autoAnswer) return false;
    const doc = video && video.ownerDocument;
    if (!doc) return false;

    const root = findQuizRoot(doc);
    if (!root || quizHandled.has(root)) return false;

    const quiz = readQuiz(root);
    if (!quiz.options.length || !quiz.submitNode) return false;

    quizHandled.add(root);
    log("检测到视频内嵌题（" + (quiz.counter || "共?题") + "），开始作答");

    let picked = [];
    try {
      const cfg = await getModelConfigCached();
      const pseudo = {
        type: quiz.options.length > 3 ? "single" : "single",
        stem: { text: quiz.stem, images: [] },
        options: quiz.options.map((o) => ({ label: o.label, text: o.text })),
      };
      const ai = await window.CXAI.askByModel(pseudo, cfg, null);
      if (!ai || !ai.ok) {
        log("内嵌题作答失败：" + ((ai && ai.reason) || "无结果"), "warn");
        quizHandled.delete(root);
        return false;
      }
      const norm = window.CXAnswer.normalizeAnswer(ai.text, pseudo);
      picked = norm.labels && norm.labels.length ? norm.labels : [];
      log("内嵌题答案：" + (picked.join("") || ai.text));
    } catch (e) {
      log("内嵌题取答案异常：" + e.message, "warn");
      quizHandled.delete(root);
      return false;
    }

    for (const label of picked) {
      const opt = quiz.options.find((o) => o.label === label);
      if (!opt) continue;
      try {
        if (opt.input) {
          opt.input.click();
          if (!opt.input.checked) opt.node.click();
        } else {
          opt.node.click();
        }
        await new Promise((r) => setTimeout(r, 250));
      } catch (e) {
        log("点选项 " + label + " 失败：" + e.message, "warn");
      }
    }

    try {
      quiz.submitNode.removeAttribute("href");
      quiz.submitNode.click();
      log("已提交内嵌题（" + picked.join("") + "）");
    } catch (e) {
      log("提交内嵌题失败：" + e.message, "warn");
    }
    await new Promise((r) => setTimeout(r, 1200));
    return true;
  }



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
    // 明确拿到了模块 iframe：就以它为准。
    // 旧逻辑"只要页面里存在 video 元素就当视频"，会把作业页（同页残留播放器）也判成视频 → 永不答题。
    if (types.length) {
      if (types.includes("video")) return "video";
      const first = types.find((t) => ["work", "worknew", "doc", "ppt", "insertdoc", "audio", "video"].includes(t));
      return first || types[0];
    }
    if (getVideo()) return "video";
    return null;
  }

  function isVideoTask() {
    return currentModuleType() === "video" || !!getVideo();
  }

  /* ---------------- 跨页面续跑（下一节=整页跳转，状态必须落盘） ---------------- */

  const RESUME_KEY = "cxVideoResume";
  const RESUME_TTL = 30 * 60 * 1000; // 30 分钟内有效

  function saveResume() {
    try {
      chrome.storage.local.set({
        [RESUME_KEY]: {
          running: true,
          options: { ...state.config },
          chapterId: new URLSearchParams(location.search).get("chapterId") || "",
          at: Date.now(),
        },
      });
    } catch (_) {}
  }

  function clearResume() {
    try { chrome.storage.local.remove(RESUME_KEY); } catch (_) {}
  }

  /** 供 entry 在页面加载时调用：上一页还在刷课就自动接上 */
  function readResume() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get([RESUME_KEY], (r) => {
          const s = r && r[RESUME_KEY];
          if (!s || !s.running) return resolve(null);
          if (Date.now() - (s.at || 0) > RESUME_TTL) { clearResume(); return resolve(null); }
          resolve(s);
        });
      } catch (_) {
        resolve(null);
      }
    });
  }

  /* ---------------- 当前任务点序号（iframe 的 num 参数最可靠） ---------------- */

  function currentTaskIndex() {
    try {
      const fr = document.getElementById("iframe");
      const m = (fr && fr.getAttribute("src") || "").match(/[?&]num=(\d+)/);
      if (m) return parseInt(m[1], 10);
    } catch (_) {}
    // 退回 tab 的高亮状态
    const tabs = window.CXModel?.readTaskTabs?.() || [];
    const idx = tabs.findIndex((t) => /cur|active|on\b/i.test(t.node.className || ""));
    return idx >= 0 ? idx : null;
  }

  /**
   * 切下一个任务点。
   * 顺序：**同章节的其它任务点 tab（AJAX，不丢状态）** → 下一节（整页跳转，靠续跑）。
   * 旧实现直接点"下一节"，会把 2内容 / 3作业 这些任务点整个跳过去。
   */
  async function nextTaskPoint() {
    const tabs = window.CXModel?.readTaskTabs?.() || [];
    const cur = currentTaskIndex();
    if (tabs.length && cur != null && cur + 1 < tabs.length) {
      const next = tabs[cur + 1];
      try {
        log("切到同章节下一个任务点：" + (next.text || ("#" + (cur + 2))));
        next.node.click();
      } catch (e) {
        log("点击任务点 tab 失败：" + e.message, "warn");
      }
      await new Promise((r) => setTimeout(r, 2500));
      return true;
    }
    return false;
  }

  /**
   * 处理"当前章节还有任务点未完成"之类的拦路弹窗。
   * 依据大学搜题酱实测：弹窗容器 .jobFinishTip，按钮是 .popBottom .nextChapter
   * （不是普通"确定"），点完要先暂停播放再继续。
   */
  function clearBlockingDialog() {
    const box = document.querySelector(".jobFinishTip, #jobFinishTip");
    if (!box) return false;
    let shown = false;
    try { shown = getComputedStyle(box).display === "block"; } catch (_) {}
    if (!shown) return false;

    const BTN = [".popBottom .nextChapter", ".popBottom a.nextChapter", ".popBottom .next", ".popBottom a", ".popBottom .btn", "#jobFinishTipFocus"];
    for (const sel of BTN) {
      let list = [];
      try { list = [...(box.querySelectorAll(sel).length ? box.querySelectorAll(sel) : document.querySelectorAll(sel))]; } catch (_) {}
      for (const el of list) {
        const t = (el.textContent || "").trim();
        // 兜底的 .popBottom a 会先命中「去学习」，那是回去补任务点，不是继续刷课
        if (/去学习|去完成/.test(t) && sel === ".popBottom a") continue;
        try {
          el.removeAttribute("href");
          el.click();
          log("已处理“任务点未完成”弹窗：" + (t || sel) + "，暂停播放等待跳转");
          const v = getVideo();
          if (v) { try { v.pause(); } catch (_) {} }
          return true;
        } catch (e) {
          log("点弹窗按钮失败：" + e.message, "warn");
        }
      }
    }
    return false;
  }

  /** 播完切下一任务点（会自动跳过 PPT / 文档等非视频） */
  async function onEnded() {
    if (!state.config.autoNext) return;
    log("当前视频已播完，准备切换下一任务点");
    await advance();
  }

  /**
   * 前进到下一个**视频**任务点。
   * 层级优先级照 U 校园那套：同章节其它任务点 → 下一节（整页跳转，落盘续跑）。
   */
  async function advance() {
    // 1) 同章节还有别的任务点：就地切换，不跳章节
    if (await nextTaskPoint()) {
      return await skipToVideo(12);
    }

    // 2) 同章节结束 → 下一节（整页跳转）
    //    先处理"任务点未完成"弹窗，可能它才是真正的下一步
    if (clearBlockingDialog()) {
      await new Promise((r) => setTimeout(r, 3000));
      if (await skipToVideo(6)) return true;
    }

    const btn = findNextButton();
    if (!btn) {
      log("已到目录末尾，请核对平台任务完成状态", "warn");
      state.running = false;
      clearResume();
      return false;
    }

    // 3) 关键：按钮在页面下方时先滚进视口，否则点击不生效（大学搜题酱同款处理）
    try {
      const nav = document.querySelector("#prevNextFocus");
      if (nav) nav.scrollIntoView({ block: "center" });
      if (document.visibilityState !== "visible") log("标签页不在前台，跳转可能被浏览器延后", "warn");
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 600));

    // 4) 导航代次：点击前记住 href，跳转就别再往旧页面塞动作
    const epochHref = location.href;
    saveResume();

    // 旧播放器先停，避免跳转后仍在上报
    try { const v = getVideo(); if (v) v.pause(); } catch (_) {}

    try { btn.click(); } catch (_) {}

    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 300));
      if (location.href !== epochHref) {
        log("已跳转到下一节，等待新页面接管");
        return true;
      }
    }
    // 没跳转：可能是拦截弹窗或同页刷新
    if (clearBlockingDialog()) {
      // 点完弹窗按钮常会整页跳转，这里再等一次 href 变化
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 300));
        if (location.href !== epochHref) {
          log("已通过弹窗入口进入下一节，等待新页面接管");
          return true;
        }
      }
    }
    await new Promise((r) => setTimeout(r, 1200));
    return await skipToVideo(12);
  }

  function findNextButton() {
    // 学习页顶部/底部的"下一节"按钮（实测 id=prevNextFocusNext，onclick=PCount.next(...)）
    const PRIORITY = [
      "#prevNextFocusNext",
      '[onclick*="PCount.next"]',
      '[onclick*="nextChapter"]',
      '[onclick*="next"]',
      '.nextChapter',
      '.next_chapter',
      'a[title*="下一"]',
      'span[title*="下一"]',
    ];
    for (const s of PRIORITY) {
      let el = null;
      try { el = document.querySelector(s); } catch (_) {}
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

  /* ---------------- 提交（章节测验/作业） ---------------- */

  /** 收集所有可访问的同域文档 */
  function allDocs() {
    const docs = [];
    try { docs.push(document); } catch (_) {}
    for (const fr of collectFrames()) {
      let d = null;
      try { d = fr.contentDocument; } catch (_) {}
      if (d && d.body) docs.push(d);
    }
    return docs;
  }

  /**
   * 点掉"确认提交？"这类二次确认弹窗。
   * 实测 doHomeWorkNew 提交后弹：.AlertCon02 / .con03 内含「确认提交？」+ 确定/取消。
   */
  async function confirmTaskSubmit(timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 6000);
    while (Date.now() < deadline) {
      for (const doc of allDocs()) {
        let nodes = [];
        try { nodes = [...doc.querySelectorAll("a,button,div,span")]; } catch (_) {}
        const hit = nodes.find((el) => {
          const t = (el.textContent || "").trim();
          if (!/^(确定|确认|确认提交|提交)$/.test(t)) return false;
          if (!el.offsetParent) return false;
          return !!el.closest('[class*="AlertCon"],[class*="con0"],[class*="popBottom"],[class*="popup"],[class*="dialog"],[class*="popBox"]');
        });
        if (hit) {
          try {
            hit.removeAttribute("href");
            hit.click();
            log("已确认提交弹窗：" + (hit.textContent || "").trim());
            await new Promise((r) => setTimeout(r, 900));
            return true;
          } catch (e) {
            log("点确认失败：" + e.message, "warn");
          }
        }
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    return false;
  }

  /** 提交当前章节测验（legacy：.btnSubmit） */
  async function submitLegacyTask() {
    try {
      const r = window.CXLegacy && window.CXLegacy.submit ? window.CXLegacy.submit() : { ok: false, reason: "CXLegacy.submit 不存在" };
      if (!r || !r.ok) {
        log("未找到测验提交按钮：" + ((r && r.reason) || "未知"), "warn");
        return false;
      }
      log("已点击测验「提交」，等待二次确认…");
      const confirmed = await confirmTaskSubmit(6000);
      if (!confirmed) log("没有出现二次确认弹窗（可能直接提交成功）");
      await new Promise((r2) => setTimeout(r2, 1500));
      return true;
    } catch (e) {
      log("提交测验失败：" + e.message, "warn");
      return false;
    }
  }

  /** 在当前任务点执行一次答题（复用页面里的答题模块） */
  async function answerCurrentTask() {
    try {
      // ⚠️ 不能用 CXLegacy.findQuestionDocs().length 判 legacy：
      //    它的选择器含 .questionLi/.answerBg，任何新版页都会被判成旧版，
      //    随后 CXLegacy.run 只认 .TiMu → 跑出 0 题（"自动答题没反应"的真因）。
      const legacy = isLegacyPage();
      const autoSubmit = state.config.autoSubmitTask !== false;
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
        r = await window.CXAnswer.run({ modelConfig, autoSubmit });
      }
      const st = (r && r.stats) || {};
      log(
        "答题完成：已答 " + (st.answered || 0) +
        "，失败 " + (st.failed || 0) +
        "，跳过 " + (st.skipped || 0) +
        (st.total ? "" : "（本页没识别到题目，可能题目在更深层 iframe 或页面未加载完）")
      );

      // 答完必须提交，否则任务点一直是"待完成"，切下一节会被拦
      if (autoSubmit && (st.answered || 0) > 0) {
        if (legacy) {
          await submitLegacyTask();
        } else {
          log("已按 autoSubmit 提交（现代结构）");
        }
      } else if ((st.answered || 0) > 0) {
        log("已答但未提交（autoSubmitTask=false），任务点可能仍是“待完成”", "warn");
      }
      return r;
    } catch (e) {
      log("答题失败：" + e.message, "warn");
      return null;
    }
  }

  /**
   * 严格判定旧版作业页：带 TiMu 的元素内部必须真的有 .Zy_TItle / li[qid]。
   * 学习页/考试整卷页的容器 class 里也带 TiMu（FullfanyaMarking TiMu），只看 class 会误判。
   */
  function isLegacyPage() {
    const MARK = ".Zy_TItle, .newZy_TItle, li[qid]";
    const docs = [];
    try { docs.push(document); } catch (_) {}
    for (const fr of collectFrames()) {
      let d = null;
      try { d = fr.contentDocument; } catch (_) {}
      if (d && d.body) docs.push(d);
    }
    for (const d of docs) {
      let nodes = [];
      try { nodes = [...d.querySelectorAll(".TiMu")]; } catch (_) {}
      for (const n of nodes) {
        try {
          if (n.querySelector(MARK)) return true;
        } catch (_) {}
      }
    }
    return false;
  }

  /**
   * 旧版任务点切换实现已由上面的 nextTaskPoint()（同章节 tab 优先）取代。
   * 保留这个别名只是为了不破坏外部调用（api.nextTaskPoint → advance）。
   */

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

    // 视频内嵌题：弹出时自动作答并提交（受"刷课时自动答题"开关控制）
    if (state.config.autoAnswer && !state._quizBusy) {
      state._quizBusy = true;
      handleVideoQuiz(video)
        .catch(() => {})
        .finally(() => { state._quizBusy = false; });
    }

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
      saveResume(); // 整页跳转后靠它续跑
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
      clearResume();
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
    readResume,
    saveResume,
    clearResume,
    currentTaskIndex,
    clearBlockingDialog,
    handleVideoQuiz,
    findQuizRoot,
    readQuiz,
  });
})();
