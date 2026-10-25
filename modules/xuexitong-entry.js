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
      legacy = window.CXLegacy ? window.CXLegacy.findQuestionDocs().length > 0 : false;
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

  /** 是否旧版作业/章节练习页（.TiMu 结构，题目常在多层 iframe 内） */
  function isLegacy() {
    try {
      if (window.CXLegacy && window.CXLegacy.findQuestionDocs().length > 0) return true;
    } catch (_) {}
    return !!document.querySelector(".TiMu");
  }

  /** 统一取题：优先 legacy，其次当前文档 */
  function collectQuestions() {
    if (isLegacy()) {
      try {
        return window.CXLegacy.extract();
      } catch (e) {
        console.warn("[学习通] legacy 提取失败：", e.message);
      }
    }
    return window.CXModel.extractQuestions();
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

    // ---- 刷视频 ----
    if (req.action === "cxStartVideo") {
      const r = window.CXVideo.start(req.options || {});
      sendResponse({ success: true, data: r });
      return true;
    }

    // ---- 答题（含章节练习）----
    if (req.action === "cxStartAnswer") {
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
          } else {
            r = await window.CXAnswer.run({
              relationType:
                pageType === "exam" ? window.CXAI.RELATION.EXAM : window.CXAI.RELATION.WORK,
              modelConfig,
              ...(req.options || {}),
            });
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

  window.__CX_SNAPSHOT__ = snapshot;
})();
