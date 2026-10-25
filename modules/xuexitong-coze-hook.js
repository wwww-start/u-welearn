/**
 * Coze AI 助手 iframe 采集器
 *
 * 运行位置：https://stat2-ans.chaoxing.com/* 的 iframe 内部（同域，可读 DOM）
 *
 * 背景（实测）：父页面调用 showAssistant() 后，iframe → 父窗口的 postMessage
 * 只有一条 {eventName:"recordMessage"} 回显，AI 的回答不通过 postMessage 回传，
 * 而是渲染在 iframe 内部面板里。所以要在 iframe 内直接读 DOM，再主动转发出去。
 */
(function () {
  "use strict";

  if (window.__CX_COZE_HOOK__) return;
  window.__CX_COZE_HOOK__ = true;

  let currentObjectId = "";

  /** 父窗口 origin（从 referrer 推断，取不到则用通配） */
  function parentOrigin() {
    try {
      if (document.referrer) return new URL(document.referrer).origin;
    } catch (_) {}
    return "*";
  }

  const PARENT = parentOrigin();

  /** 记录父页面发来的 objectId（用于与题目关联） */
  window.addEventListener("message", (e) => {
    const d = e.data;
    if (!d || typeof d !== "object") return;
    if (d.objectId) currentObjectId = String(d.objectId);
    if (d.eventName === "recordMessage" && d.objectId) currentObjectId = String(d.objectId);
  });

  /* ---------------- 回答文本采集 ---------------- */

  // 常见 AI 回答容器特征（宽泛匹配，不同版本可能变化）
  const SELECTORS = [
    '[class*="markdown"]',
    '[class*="message-content"]',
    '[class*="messageContent"]',
    '[class*="answer-content"]',
    '[class*="ai-content"]',
    '[class*="bubble"]',
    '[class*="chat-item"]',
    '[class*="msg-item"]',
    '[class*="coze"]',
  ];

  const seen = new Set();
  let lastEmit = 0;
  let debounceTimer = null;

  /** 判断一段文本像不像"答案/解析"（而不是用户提问或占位符） */
  function looksLikeAnswer(text) {
    if (!text || text.length < 8) return false;
    if (/^讲解一下这道题/.test(text)) return false; // SDK 自动提问
    if (/^(加载中|正在生成|思考中|请稍候)/.test(text)) return false;
    // 命中任一特征即认为有效
    return (
      /正确答案|答案|选项|解析|因为|所以|故选|计算|公式|知识点/.test(text) ||
      /[A-D][.．、]/.test(text) ||
      text.length > 60
    );
  }

  /** 收集当前面板里最可能的一段回答 */
  function collectOnce() {
    let best = "";
    for (const sel of SELECTORS) {
      for (const node of document.querySelectorAll(sel)) {
        const t = (node.innerText || "").trim();
        if (!t || t.length < 8) continue;
        if (t.length > best.length && looksLikeAnswer(t)) best = t;
      }
    }
    return best;
  }

  function emit(text) {
    if (!text) return;
    if (seen.has(text)) return;
    // 内容仍在增长时，用前缀比较去重
    for (const s of seen) {
      if (text.startsWith(s) && text.length - s.length < 30) return;
      if (s.startsWith(text)) return;
    }
    seen.add(text);
    lastEmit = Date.now();

    try {
      window.parent.postMessage(
        {
          __cxai: true,
          kind: "answer",
          objectId: currentObjectId,
          text,
          url: location.href,
        },
        PARENT
      );
    } catch (_) {}
  }

  /** 防抖观察：AI 是逐字流式渲染，静默 1.2s 视为说完 */
  const observer = new MutationObserver(() => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const t = collectOnce();
      if (t) emit(t);
    }, 1200);
  });

  function start() {
    const root = document.body;
    if (!root) return;
    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    // 就绪信号
    try {
      window.parent.postMessage(
        { __cxai: true, kind: "ready", url: location.href },
        PARENT
      );
    } catch (_) {}
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }

  // 暴露手动采集（调试用）
  window.__CX_COZE_COLLECT__ = () => {
    const t = collectOnce();
    if (t) emit(t);
    return t;
  };
})();
