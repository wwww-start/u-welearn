/**
 * 学习通总入口
 *
 * 职责：
 *   1. 判定当前页面类型（video / study / work / exam / paper-review）
 *   2. 承接侧边栏消息，路由到对应控制器
 *   3. 汇总状态，供 popup 轮询
 *
 * 消息协议（content ⇄ background/popup）：
 *   {action:"cxStatus"}                → 状态快照
 *   {action:"cxScan"}                  → 题目摘要列表
 *   {action:"cxStartVideo", options}   → 启动刷视频
 *   {action:"cxStartAnswer", options}  → 启动答题（作业/测验）
 *   {action:"cxStartExam", options}    → 启动考试作答
 *   {action:"cxStop"}                  → 停止一切
 */
(function () {
  "use strict";

  if (window.__CX_ENTRY__) return;
  window.__CX_ENTRY__ = true;

  // 本组脚本用 <all_urls> 注入（保证任何学习通子域都能进），
  // 因此必须在这里快速排除无关页面，避免拖慢其它网站。
  const site = window.CXModel.detectSite();
  const hasChaoxingDom = !!document.querySelector(
    ".fanyaMarking, .TiMu, .questionLi, .answerBg, .mark_name, " +
    "ul.prev_ul, .posCatalog_name, #iframe, #cozeIframe"
  );
  const isVideoPage = location.pathname.indexOf("/ananas/modules/") !== -1;

  if (site !== window.CXModel.SITE.CHAOXING && !hasChaoxingDom && !isVideoPage) {
    return; // 非学习通页面，直接退出
  }

  const pageType = window.CXModel.detectPageType();
  const params = window.CXModel.parseParams();

  console.info(
    "[学习通] 已加载 | 页面类型: " + pageType,
    "| courseId=" + (params.courseId || "-"),
    "clazzId=" + (params.clazzId || "-")
  );

  /** 从 popup 拿当前启用的模型配置 */
  function getModelConfig() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: "getActiveModelConfig" }, (r) => {
        if (chrome.runtime.lastError) return resolve(null);
        resolve(r?.config || null);
      });
    });
  }

  function snapshot() {
    let legacy = false;
    let legacyStats = null;
    try {
      legacy = isLegacy();
      if (legacy) legacyStats = window.CXLegacy.stats();
    } catch (_) {}
    let moduleType = null;
    try {
      moduleType = window.CXVideo?.currentModuleType?.() || null;
    } catch (_) {}
    return {
      site,
      pageType,
      legacy,
      legacyStats,
      moduleType,
      params,
      video: window.CXVideo?.status?.() || null,
      answer: window.CXAnswer?.status?.() || null,
      exam: window.CXExam?.status?.() || null,
      globalGuard: !!window.__CX_VIDEO_GUARD__,
    };
  }

  /**
   * 是否旧版作业/章节练习页（.TiMu 结构，题目常在多层 iframe 内）。
   *
   * ⚠️ 两个坑（都有实测页面为证）：
   *   1. CXLegacy.findQuestionDocs() 的选择器含 .questionLi/.answerBg，拿它判定会把新版页误判为 legacy；
   *   2. 新版考试整卷页的容器是 <div id="fanyaMarking" class="FullfanyaMarking TiMu">，
   *      容器自身就带 TiMu —— 只判断 `.TiMu` 是否存在同样会误判，然后 extract() 只取到容器 → 1 题。
   * 因此必须要求「带 TiMu 的元素内部真的有旧版题目特征」。
   */
  function isLegacy() {
    const LEGACY_MARK = ".Zy_TItle, .newZy_TItle, li[qid]";
    let nodes = [];
    try {
      nodes = [...document.querySelectorAll(".TiMu")];
    } catch (_) {}
    try {
      const docs = window.CXLegacy ? window.CXLegacy.findQuestionDocs() : [];
      for (const d of docs) nodes = nodes.concat([...d.querySelectorAll(".TiMu")]);
    } catch (_) {}
    for (const n of nodes) {
      try {
        if (n.querySelector(LEGACY_MARK)) return true;
      } catch (_) {}
    }
    return false;
  }

  /** 统一取题：优先与页面结构匹配的那一套，取不到再互相兜底 */
  function collectQuestions() {
    const legacy = isLegacy();
    if (legacy) {
      try {
        const qs = window.CXLegacy.extract();
        if (qs.length) return qs;
      } catch (e) {
        console.warn("[学习通] legacy 提取失败：", e.message);
      }
    }
    let modern = [];
    try {
      modern = (window.CXModel.extractQuestionsDeep || window.CXModel.extractQuestions)();
    } catch (e) {
      console.warn("[学习通] 新版结构提取失败：", e.message);
    }
    if (modern.length) return modern;
    // 兜底：结构混排时两套都试一遍
    try {
      const l = window.CXLegacy ? window.CXLegacy.extract() : null;
      if (l && l.length) return l;
    } catch (_) {}
    return modern;
  }

  /**
   * 结构自检：把页面骨架（标签、类名、id、role、data 属性、onclick、短文本）落库，
   * 供适配真实页面时使用。不采集答题内容以外的东西，也不外发。
   */
  function inspectDom() {
    const MAX_NODES = 600;
    let n = 0;
    const SKIP = new Set(["SCRIPT", "STYLE", "LINK", "META", "NOSCRIPT"]);
    function pick(el) {
      const o = { t: el.tagName.toLowerCase() };
      if (el.id) o.id = el.id;
      if (el.className && typeof el.className === "string") o.c = el.className.trim().slice(0, 120);
      for (const a of ["role", "type", "name", "data", "qid", "qtype", "onclick", "href", "value", "disabled", "aria-label"]) {
        const v = el.getAttribute && el.getAttribute(a);
        if (v != null && v !== "") o[a] = String(v).slice(0, 120);
      }
      return o;
    }
    function walk(el, depth) {
      if (n >= MAX_NODES || depth > 7) return null;
      n++;
      const node = pick(el);
      // 文本只在没有块级子节点时记，避免整段正文
      const kids = [...el.children].filter((c) => !SKIP.has(c.tagName));
      if (!kids.length) {
        const t = (el.textContent || "").replace(/\s+/g, " ").trim();
        if (t) node.x = t.slice(0, 60);
      }
      if (kids.length) {
        node.k = kids.map((c) => walk(c, depth + 1)).filter(Boolean);
      }
      return node;
    }
    const roots = [
      "#fanyaMarking", "#examAnswerPage", ".fanyaMarking", ".questionLi", ".TiMu",
      "#answerSheet", ".answerSheet", "#randomOptions", ".examQuestion",
    ].map((s) => {
      try { return document.querySelector(s); } catch (_) { return null; }
    }).filter(Boolean);

    const counts = {};
    for (const s of [".questionLi", ".TiMu", "#fanyaMarking", "#examAnswerPage", "#answerSheet",
      ".answerBg", ".mark_letter", "li[role=option]", "li[data-asq]", "li.nav-revise",
      "#randomOptions", "input[name=questionId]", ".stem_answer", ".rightAnswerContent", ".stuAnswerContent"]) {
      try { counts[s] = document.querySelectorAll(s).length; } catch (_) { counts[s] = -1; }
    }

    const snapshot = {
      ts: new Date().toISOString(),
      url: location.href,
      pageType,
      params,
      title: document.title,
      counts,
      trees: roots.slice(0, 3).map((el) => walk(el, 0)),
      bodyFallback: roots.length ? null : walk(document.body, 3),
    };
    try { chrome.storage.local.set({ cxInspect: snapshot }); } catch (_) {}
    return snapshot;
  }

  /**
   * 页面是不是"只能看不能改"（回顾页/已批改）。
   * 不再靠 URL 里的 preview/look 猜——按页面实际能力判断：
   *   有提交按钮 或 有可点选项/答案输入  → 可作答
   *   两者都没有、但有批改标记/正确答案 → 只读
   */
  function looksReadonly() {
    try {
      const hasSubmit = !!document.querySelector(
        '#submitTest, #submitBtn, .btnSubmit, [onclick*="submitTest"], [class*="submitTest"]'
      );
      const hasAnswerSurface =
        document.querySelectorAll(
          'input[name="questionId"], .answerBg, #randomOptions, ul li[role="option"], li[onclick*="addChoice"]'
        ).length > 0;
      if (hasSubmit || hasAnswerSurface) return false;
      return (
        document.querySelectorAll(".marking_dui, .marking_cuo, .rightAnswerContent, .mark_score, .stem_answer")
          .length > 0
      );
    } catch (_) {
      return false;
    }
  }

  /** 只读页才拦；能作答的页面一律放行 */
  function readonlyReason() {
    if (pageType !== "exam-preview") return null;
    if (!looksReadonly()) return null;
    return "当前是考试查看/回顾页（只读），选项点不动。请到作答页（exam-ans/mooc2/exam/preview 或 reVersionPaperMarkContentNew）再点答题。";
  }

  chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
    if (!req || !req.action) return;

    // ---- 状态 ----
    if (req.action === "cxStatus") {
      sendResponse({ success: true, data: snapshot() });
      return true;
    }

    // ---- 扫描 ----
    if (req.action === "cxScan") {
      const qs = collectQuestions();
      const legacy = isLegacy();
      sendResponse({
        success: true,
        data: {
          pageType,
          legacy,
          count: qs.length,
          byType: qs.reduce((a, q) => (a[q.type] = (a[q.type] || 0) + 1, a), {}),
          questions: qs.map((q) => ({
            seq: q.seq,
            index: q.index,
            qid: q.qid,
            type: q.type,
            stemText: (q.stem?.text || "").slice(0, 60),
            hasImage: (q.stem?.images || []).length > 0,
            optionCount: (q.options || []).length,
            answered: !!(q.answers && q.answers.mine),
          })),
        },
      });
      return true;
    }

    // ---- 结构自检 ----
    if (req.action === "cxInspect") {
      try {
        sendResponse({ success: true, data: inspectDom() });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
      return true;
    }

    // ---- 刷视频 ----
    if (req.action === "cxStartVideo") {
      const r = window.CXVideo.start(req.options || {});
      sendResponse({ success: true, data: r });
      return true;
    }

    // ---- 诊断探针（验证刷课/自动答题链路）----
    if (req.action === "cxProbe") {
      (async () => {
        const name = req.name || "diag";
        try {
          if (name === "diag") {
            sendResponse({
              success: true,
              data: {
                pageType,
                moduleType: window.CXVideo?.currentModuleType?.() || null,
                taskIndex: window.CXVideo?.currentTaskIndex?.() ?? null,
                tabs: (window.CXModel?.readTaskTabs?.() || []).map((t) => t.text),
                deepQuestions: (window.CXModel?.extractQuestionsDeep || window.CXModel?.extractQuestions || (() => []))().length,
                flatQuestions: (window.CXModel?.extractQuestions || (() => []))().length,
                videoRunning: !!window.CXVideo?.status?.().running,
                framing: {
                  nextBtn: !!document.querySelector("#prevNextFocusNext"),
                  dialog: !!document.querySelector("#jobFinishTip .popBottom a"),
                },
              },
            });
          } else if (name === "answerTask") {
            const r = await window.CXVideo.answerCurrentTask();
            sendResponse({ success: true, data: r });
          } else if (name === "advance") {
            const steps = {};
            try {
              steps.tabs = (window.CXModel.readTaskTabs() || []).map((t) => t.text);
              steps.taskIndex = window.CXVideo.currentTaskIndex();
              steps.nextBtn = !!window.CXVideo.findNextButton();
              steps.iframeSrc = (document.getElementById("iframe") || {}).src || "";
              const dlg = document.querySelector("#jobFinishTip, .jobFinishTip, .AlertCon02");
              steps.dialogVisible = !!(dlg && getComputedStyle(dlg).display !== "none" && dlg.getClientRects().length);
            } catch (err) { steps.err = String(err && err.message); }
            const before = location.href;
            const r = await window.CXVideo.advance();
            sendResponse({ success: true, data: { result: r, steps, hrefBefore: before, hrefAfter: location.href, logs: (window.CXVideo.status().logs || []).slice(-12).map((l) => l.msg) } });
          } else if (name === "quiz") {
            const v = window.CXVideo.getVideo();
            const root = v ? window.CXVideo.findQuizRoot(v.ownerDocument) : null;
            const info = root ? window.CXVideo.readQuiz(root) : null;
            const done = v ? await window.CXVideo.handleVideoQuiz(v, true) : false;
            sendResponse({
              success: true,
              data: {
                hasVideo: !!v,
                quizFound: !!root,
                rootTag: root ? root.tagName + "." + (root.className || "") : null,
                rootText: root ? String(root.textContent || "").replace(/\s+/g, " ").slice(0, 160) : null,
                submitFound: !!(info && info.submitNode),
                optionCount: info ? info.options.length : 0,
                options: info ? info.options.map((o) => o.label + ":" + o.text.slice(0, 24)) : [],
                stem: info ? info.stem.slice(0, 160) : "",
                handled: done,
              },
            });
          } else if (name === "resume") {
            const s = await window.CXVideo.readResume();
            sendResponse({ success: true, data: s });
          } else {
            sendResponse({ success: false, error: "未知探针：" + name });
          }
        } catch (e) {
          sendResponse({ success: false, error: e.message });
        }
      })();
      return true;
    }

    // ---- 答题（含章节练习）----
    if (req.action === "cxStartAnswer") {
      const ro = readonlyReason();
      if (ro) {
        sendResponse({ success: false, error: ro });
        return true;
      }
      (async () => {
        const modelConfig = await getModelConfig();
        try {
          let r;
          if (isLegacy()) {
            r = await window.CXLegacy.run({
              modelConfig,
              perQuestionTimeoutMs: 45000,
              ...(req.options || {}),
            });
            // legacy 取到 0 题而新版结构有题时，兜底走新版控制器
            if (!r || !r.stats || !r.stats.total) {
              const modern = window.CXModel.extractQuestions();
              if (modern.length) {
                r = await window.CXAnswer.run({
                  relationType: window.CXAI.RELATION.WORK,
                  modelConfig,
                  ...(req.options || {}),
                });
              }
            }
          } else {
            // 新版结构分流：
            //   整卷（一页多题）→ CXAnswer 逐题遍历，不翻页、不交卷；
            //   一屏一题且有「下一题」→ CXExam（单题限时感知，默认仍不自动翻页）。
            const qs = collectQuestions();
            const hasNextNav = !!document.querySelector(
              '#nextPage, a.nextPage, [onclick*="nextPage"], .nextPage, a[class*="next"]'
            );
            if (qs.length > 1 || !hasNextNav) {
              r = await window.CXAnswer.run({
                relationType: window.CXAI.RELATION.WORK,
                modelConfig,
                ...(req.options || {}),
              });
            } else {
              r = await window.CXExam.run({
                relationType: window.CXAI.RELATION.EXAM,
                modelConfig,
                autoAdvance: false,
                ...(req.options || {}),
              });
            }
          }
          sendResponse({ success: true, data: r });
        } catch (e) {
          sendResponse({ success: false, error: e.message });
        }
      })();
      return true; // 异步
    }

    // ---- 考试 ----
    if (req.action === "cxStartExam") {
      const ro = readonlyReason();
      if (ro) {
        sendResponse({ success: false, error: ro });
        return true;
      }
      (async () => {
        const modelConfig = await getModelConfig();
        try {
          let r;
          if (isLegacy()) {
            r = await window.CXLegacy.run({ modelConfig, ...(req.options || {}) });
          } else {
            r = await window.CXExam.run({
              relationType: window.CXAI.RELATION.EXAM,
              modelConfig,
              ...(req.options || {}),
            });
          }
          sendResponse({ success: true, data: r });
        } catch (e) {
          sendResponse({ success: false, error: e.message });
        }
      })();
      return true;
    }

    // ---- 停止 ----
    if (req.action === "cxStop") {
      window.CXVideo?.stop?.();
      window.CXAnswer?.pause?.();
      window.CXExam?.pause?.();
      sendResponse({ success: true });
      return true;
    }

    // ---- 手动提交（用户确认后才执行）----
    if (req.action === "cxSubmit") {
      (async () => {
        try {
          let submitted = false;
          if (isLegacy()) {
            submitted = !!window.CXLegacy.submit().ok;
          } else if (pageType === "exam") {
            submitted = await window.CXExam.submitExam();
          } else {
            submitted = await window.CXAnswer.submitPaper();
          }
          sendResponse({ success: true, data: { submitted } });
        } catch (e) {
          sendResponse({ success: false, error: e.message });
        }
      })();
      return true;
    }

    // ---- 核对：列出未作答题目 ----
    if (req.action === "cxVerify") {
      const qs = collectQuestions();
      const unanswered = qs
        .filter((q) => !(q.answers && q.answers.mine))
        .map((q) => ({
          seq: q.seq,
          index: q.index,
          type: q.type,
          stem: (q.stem?.text || "").slice(0, 40),
        }));
      sendResponse({
        success: true,
        data: { total: qs.length, unansweredCount: unanswered.length, unanswered },
      });
      return true;
    }

    // ---- 兼容 popup 原有的 getStatus ----
    if (req.action === "getStatus") {
      const qs = collectQuestions();
      sendResponse({
        pageType,
        legacy: isLegacy(),
        questionCount: qs.length,
        answeredCount: qs.filter((q) => q.answers && q.answers.mine).length,
        isRunning:
          !!window.CXVideo?.status?.().running ||
          !!window.CXAnswer?.status?.().running ||
          !!window.CXExam?.status?.().running,
      });
      return true;
    }
  });

  // 页面类型自动提示
  const tips = {
    video: "检测到播放器页，可启动「刷视频」",
    study: "检测到学习页，可切换任务点 / 启动视频控制",
    work: "检测到作业作答页，可启动「答题」",
    "work-list": "检测到作业列表，请进入具体作业",
    exam: "检测到考试页，可启动「考试作答」（注意单题限时与人脸核验）",
    "paper-review": "检测到试卷回顾页，答案已在页面中",
  };
  if (tips[pageType]) console.info("[学习通] " + tips[pageType]);

  // 考试/作业页自动留一份结构快照（只读 DOM，不改页面、不点任何东西），
  // 便于下次按真实结构适配。落在 chrome.storage.local 的 cxInspect 键。
  if (pageType === "exam" || pageType === "exam-preview" || pageType === "work") {
    try { inspectDom(); } catch (e) { console.warn("[学习通] 结构快照失败：", e.message); }
  }

  // 刷课续跑：学习页点"下一节"是整页跳转，旧脚本随之销毁；
  // 新页面加载后按落盘状态自动接上，否则每翻一节就断一次。
  if (pageType === "study" || pageType === "video") {
    (async () => {
      let st = null;
      try {
        st = window.CXVideo && window.CXVideo.readResume ? await window.CXVideo.readResume() : null;
      } catch (_) {}
      if (!st) return;
      await new Promise((r) => setTimeout(r, 1800));
      try {
        window.CXVideo.start(st.options || {});
        console.info("[学习通] 检测到未完成的刷课任务，已自动续跑");
      } catch (e) {
        console.warn("[学习通] 续跑失败：", e.message);
      }
    })();
  }

  window.__CX_SNAPSHOT__ = snapshot;
})();
