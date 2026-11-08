// ==UserScript==
// @name         学习通当前页结构采集器
// @namespace    local.chaoxing.page-collector
// @version      1.1.0
// @description  只读采集学习通当前页结构：题目/选项/答题卡/视频内嵌题/翻页按钮，含同域 iframe 递归。不点击、不修改、不提交。
// @match        https://*.chaoxing.com/*
// @match        https://*.xuexitong.com/*
// @match        https://*.chaoxing.cn/*
// @match        https://*.cxfanya.com/*
// @run-at       document-idle
// @grant        none
// @noframes     false
// ==/UserScript==

/*
 * 设计约束：
 *   1. 全程只读：不 click、不 focus、不 scrollIntoView、不改节点属性。
 *   2. 默认折叠成小圆点，Alt+H 显示/隐藏。
 *   3. 同域 iframe 直接读 contentDocument 递归；跨域退回 postMessage。
 *   4. 暴露 window.__CX_CAP__ 供控制台/自动化调用。
 */
(() => {
  'use strict';

  const KIND = 'chaoxing-page-capture-v1';
  const isTop = window === window.top;

  const clean = (v, limit = 2000) =>
    String(v == null ? '' : v)
      .replace(/\r/g, '')
      .replace(/[\t ]+/g, ' ')
      .replace(/\n\s*\n+/g, '\n')
      .trim()
      .slice(0, limit);

  const isChaoxingOrigin = (origin) =>
    /^https:\/\/(?:[a-z0-9-]+\.)*(?:chaoxing\.com|xuexitong\.com|chaoxing\.cn|cxfanya\.com)$/i.test(origin || '') ||
    origin === location.origin;

  const PROBES = [
    '.TiMu', '.newTiMu', '.Zy_TItle', '.Zy_ulTop', '.newZy_TItle', '.font-cxsecret',
    '.questionLi', '.mark_name', '.colorShallow', '.mark_letter', '.mark_answer',
    '.stuAnswerContent', '.rightAnswerContent', '.mark_score', '.marking_dui', '.marking_cuo',
    '.fanyaMarking', '.problem-fixedbar',
    '#fanyaMarking', '#examAnswerPage', '#answerSheet', '#answerSheetH', '.answerSheet',
    '.answerSheetBox', '.Marking_right_280', '.markingRight_paper', '.topicNumber_list',
    'ul.topicNumber_list', '.legendBox', '.phone_main_title', 'h4.cardTit',
    'li[data-asq]', 'li[id^="answerSheet"]', 'li.nav-revise', '.asMk', '.asMarked',
    '#randomOptions', '.randomOptions', '.answerBg', '.num_option', '.answer_p',
    '.stem_answer', '.answerList', '.examQuestion',
    '#submitTest', '.btnSubmit', '.btnSave', 'input[name="questionId"]',
    'input[type="hidden"][name^="answer"]', 'input[id^="answer"]',
    '#prevNextFocusNext', '#prevNextFocusPrev', '#prev_tab', 'ul.prev_ul',
    '#iframe', '.jobFinishTip', '#jobFinishTip',
    'video', 'audio', 'iframe', 'img',
  ];

  function visible(el) {
    try {
      if (!el || !el.isConnected) return false;
      const st = getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden') return false;
      return el.getClientRects().length > 0;
    } catch (_) {
      return false;
    }
  }

  function pickAttrs(el) {
    const o = { tag: el.tagName ? el.tagName.toLowerCase() : '?' };
    if (el.id) o.id = el.id;
    const cls = el.getAttribute && el.getAttribute('class');
    if (cls) o.class = String(cls).trim().slice(0, 140);
    for (const a of ['role', 'type', 'name', 'data', 'qid', 'qtype', 'value', 'onclick', 'href', 'aria-label', 'title', 'disabled', 'src']) {
      let v;
      try { v = el.getAttribute && el.getAttribute(a); } catch (_) { v = null; }
      if (v != null && v !== '') o[a] = clean(v, 140);
    }
    return o;
  }

  function skeleton(root, maxDepth = 6, maxNodes = 700) {
    let n = 0;
    const SKIP = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'SVG']);
    function walk(el, depth) {
      if (n >= maxNodes || depth > maxDepth) return null;
      n++;
      const node = pickAttrs(el);
      const kids = [...el.children].filter((c) => !SKIP.has(c.tagName));
      if (!kids.length) {
        const t = clean(el.textContent, 80);
        if (t) node.text = t;
      }
      if (kids.length) node.children = kids.map((c) => walk(c, depth + 1)).filter(Boolean);
      return node;
    }
    return walk(root, 0);
  }

  /** 文案命中导航/提交的可点元素 */
  function controlCandidates(doc) {
    const WORDS = /下一|上一|下一页|上一页|提交|交卷|保存|暂存|确认|确定|开始考试|继续|返回/;
    const out = [];
    let nodes = [];
    try {
      nodes = doc.querySelectorAll('a, button, input[type="button"], input[type="submit"], [role="button"], [onclick], .btn, [class*="btn"]');
    } catch (_) {}
    for (const el of nodes) {
      if (out.length >= 120) break;
      if (!visible(el)) continue;
      const text = clean(el.innerText || el.value || '', 40);
      if (!WORDS.test(text)) continue;
      out.push({ ...pickAttrs(el), text });
    }
    return out;
  }

  /** 答题卡里“当前题”所在项 */
  function activeSheetItems(doc) {
    const sel = [
      '#answerSheet li.active', '#answerSheet li.cur', '#answerSheet li.current', '#answerSheet li.on',
      '.answerSheet li.active', '.answerSheet li.cur', '.topicNumber_list li.active',
      '.topicNumber_list li.cur', 'ul.topicNumber_list li.on', 'li[data-asq].active',
      'li.nav-revise.active', 'li.nav-revise.cur', 'li.nav-revise.on',
    ].join(',');
    try {
      return [...doc.querySelectorAll(sel)].slice(0, 20).map((el) => ({
        ...pickAttrs(el),
        text: clean(el.innerText, 20),
      }));
    } catch (_) {
      return [];
    }
  }

  /**
   * 视频内嵌题（播放器里弹的测验）专项探测。
   * 特征：容器内出现「单选题/多选题/判断题」+「共 N 题，已答对 M 题」，另有「提交」按钮。
   * 不猜类名，按文本反查真实结构。
   */
  function probeVideoQuiz(doc) {
    const out = {
      found: false,
      hasVideo: false,
      roots: [],
      submits: [],
      options: [],
      counters: [],
      radios: [],
    };
    let body = null;
    try { body = doc.body; } catch (_) { return out; }
    if (!body) return out;

    try { out.hasVideo = !!doc.querySelector('video'); } catch (_) {}

    let blocks = [];
    try { blocks = [...body.querySelectorAll('div,section,form,ul,ol')]; } catch (_) {}
    for (const el of blocks) {
      const t = clean(el.innerText || '', 3000).replace(/\s+/g, ' ');
      if (!/(单选题|多选题|判断题)/.test(t)) continue;
      if (!/共\s*\d+\s*题|已答对/.test(t)) continue;
      if (t.length > 2000) continue;
      out.found = true;
      out.roots.push({
        ...pickAttrs(el),
        text: t.slice(0, 120),
        children: [...el.children].slice(0, 8).map((c) => pickAttrs(c)),
      });
      if (out.roots.length >= 3) break;
    }

    try {
      for (const el of body.querySelectorAll('a,button,div,span,input')) {
        if (out.submits.length >= 8) break;
        const t = clean(el.innerText || el.value || '', 12);
        if (!/^提交$|提交答案|确认提交/.test(t)) continue;
        out.submits.push({ ...pickAttrs(el), text: t, visible: visible(el) });
      }
    } catch (_) {}

    try {
      const opts = body.querySelectorAll('input[type="radio"], input[type="checkbox"], li[class*="opt"], label[class*="opt"], div[class*="opt"], li[class*="answer"]');
      for (const el of opts) {
        if (out.options.length >= 14) break;
        if (!visible(el)) continue;
        out.options.push({ ...pickAttrs(el), text: clean(el.innerText || '', 60) });
      }
    } catch (_) {}

    try {
      for (const el of body.querySelectorAll('span,div,p,i')) {
        const t = clean(el.innerText || '', 40);
        if (/共\s*\d+\s*题/.test(t) && t.length < 40) {
          out.counters.push({ ...pickAttrs(el), text: t });
          if (out.counters.length >= 3) break;
        }
      }
    } catch (_) {}

    try {
      for (const el of body.querySelectorAll('input[type="radio"], input[type="checkbox"]')) {
        if (out.radios.length >= 10) break;
        out.radios.push({ ...pickAttrs(el), visible: visible(el) });
      }
    } catch (_) {}

    return out;
  }

  /** 单帧页面快照（只读） */
  function buildPage(doc, framePath) {
    const counts = {};
    for (const sel of PROBES) {
      try { counts[sel] = doc.querySelectorAll(sel).length; } catch (_) { counts[sel] = -1; }
    }

    const ROOT_CANDIDATES = [
      '#fanyaMarking', '#examAnswerPage', '.fanyaMarking', '.questionLi', '.TiMu', '#randomOptions', 'body',
    ];
    let rootEl = null;
    for (const sel of ROOT_CANDIDATES) {
      try {
        const el = doc.querySelector(sel);
        if (el) { rootEl = el; break; }
      } catch (_) {}
    }

    const optionPools = [];
    for (const sel of [
      '.mark_letter li', '#randomOptions li', '.randomOptions li', 'ul li[role="option"]',
      'li[onclick*="addChoice"]', '.stem_answer li', '.answerList li', '.TiMu ul li', '.questionLi ul li',
    ]) {
      let list = [];
      try { list = [...doc.querySelectorAll(sel)]; } catch (_) {}
      if (!list.length) continue;
      optionPools.push({
        selector: sel,
        count: list.length,
        items: list.slice(0, 12).map((el) => ({ ...pickAttrs(el), text: clean(el.innerText, 60) })),
      });
    }

    const hiddenInputs = [];
    try {
      for (const el of doc.querySelectorAll('input[type="hidden"], input[name], input[id]')) {
        if (hiddenInputs.length >= 60) break;
        hiddenInputs.push({ ...pickAttrs(el), value: clean(el.value, 60) });
      }
    } catch (_) {}

    const frames = [];
    try {
      for (const f of doc.querySelectorAll('iframe')) {
        frames.push({ src: clean(f.getAttribute('src'), 200), name: f.name || '', id: f.id || '' });
      }
    } catch (_) {}

    let quiz = null;
    try { quiz = probeVideoQuiz(doc); } catch (e) { quiz = { error: String(e && e.message) }; }

    let bodyText = '';
    try { bodyText = clean(doc.body ? doc.body.innerText : '', 4000); } catch (_) {}

    return {
      frame: framePath,
      url: (() => { try { return doc.location ? doc.location.href : ''; } catch (_) { return ''; } })(),
      host: (() => { try { return doc.location ? doc.location.host : ''; } catch (_) { return ''; } })(),
      path: (() => { try { return doc.location ? doc.location.pathname : ''; } catch (_) { return ''; } })(),
      title: (() => { try { return doc.title || ''; } catch (_) { return ''; } })(),
      readyState: (() => { try { return doc.readyState; } catch (_) { return ''; } })(),
      counts,
      rootSelector: rootEl ? (rootEl.id ? '#' + rootEl.id : rootEl.className || rootEl.tagName.toLowerCase()) : null,
      skeleton: rootEl ? skeleton(rootEl) : null,
      controls: controlCandidates(doc),
      activeSheet: activeSheetItems(doc),
      optionPools,
      hiddenInputs,
      frames,
      videoQuiz: quiz,
      bodyText,
    };
  }

  /** 当前帧快照 */
  function snapshot() {
    return Object.assign(buildPage(document, isTop ? 'top' : 'child'), {
      capturedAt: new Date().toISOString(),
    });
  }

  /** 递归采集同域 iframe */
  function deepFrames(doc, path, depth, acc) {
    if (depth > 5) return acc;
    let frames = [];
    try { frames = [...doc.querySelectorAll('iframe')]; } catch (_) {}
    frames.forEach((fr, i) => {
      let inner = null;
      try { inner = fr.contentDocument; } catch (_) {}
      if (!inner || !inner.body) return;
      const here = path + '/iframe[' + i + ']';
      try { acc.push(buildPage(inner, here)); } catch (e) { acc.push({ frame: here, error: String(e && e.message) }); }
      deepFrames(inner, here, depth + 1, acc);
    });
    return acc;
  }

  /* ---------------- 子 frame：响应跨域采集请求 ---------------- */
  if (!isTop) {
    addEventListener('message', (event) => {
      const d = event.data;
      if (!d || d.kind !== KIND || d.command !== 'capture') return;
      if (!isChaoxingOrigin(event.origin)) return;
      let page = null;
      try { page = snapshot(); } catch (e) { page = { error: String(e && e.message) }; }
      try { event.source.postMessage({ kind: KIND, requestId: d.requestId, page }, event.origin || '*'); } catch (_) {}
    });
    try { globalThis.__CX_CAP__ = { snapshot }; } catch (_) {}
    return;
  }

  /* ---------------- 主 frame ---------------- */
  async function capture() {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const pages = [];
    const onMessage = (event) => {
      const d = event.data;
      if (!d || d.kind !== KIND || d.requestId !== requestId || !d.page) return;
      if (!isChaoxingOrigin(event.origin)) return;
      pages.push(d.page);
    };
    addEventListener('message', onMessage);

    let self = null;
    try { self = snapshot(); } catch (e) { self = { error: String(e && e.message) }; }

    // 1) 同域 iframe：直接递归读（视频内嵌题就在这里）
    const sameOrigin = [];
    try { deepFrames(document, 'top', 0, sameOrigin); } catch (_) {}

    // 2) 跨域 iframe：退回 postMessage
    try {
      for (const f of document.querySelectorAll('iframe')) {
        let readable = false;
        try { readable = !!(f.contentDocument && f.contentDocument.body); } catch (_) {}
        if (readable) continue;
        try { f.contentWindow.postMessage({ kind: KIND, command: 'capture', requestId }, '*'); } catch (_) {}
      }
    } catch (_) {}

    await new Promise((r) => setTimeout(r, 900));
    removeEventListener('message', onMessage);

    const result = {
      kind: KIND,
      capturedAt: new Date().toISOString(),
      top: self,
      sameOriginFrames: sameOrigin,
      crossOriginFrames: pages,
      frameCount: sameOrigin.length + pages.length,
      videoQuizFound: [self, ...sameOrigin].some((p) => p && p.videoQuiz && p.videoQuiz.found),
    };
    try { localStorage.setItem('cx_capture_last', JSON.stringify(result)); } catch (_) {}
    return result;
  }

  function download(result) {
    const t = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    const stamp = `${t.getFullYear()}${p2(t.getMonth() + 1)}${p2(t.getDate())}-${p2(t.getHours())}${p2(t.getMinutes())}${p2(t.getSeconds())}`;
    const safe = (location.host + location.pathname).replace(/[^\w.-]+/g, '_').slice(0, 60);
    const name = `cx-capture-${safe}-${stamp}.json`;
    const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    return name;
  }

  /* ---------------- 面板 ---------------- */
  const panel = document.createElement('div');
  panel.id = 'cx-structure-collector';
  panel.style.cssText = [
    'position:fixed', 'right:12px', 'bottom:12px', 'z-index:2147483647',
    'background:#fff', 'color:#111', 'border:1px solid #999', 'border-radius:10px',
    'padding:8px', 'box-shadow:0 2px 10px rgba(0,0,0,.25)', 'font:12px/1.5 system-ui',
    'max-width:320px', 'opacity:.85',
  ].join(';');
  panel.innerHTML =
    '<div data-dot style="cursor:pointer;font-weight:600">⦿ 结构采集 v1.1.0</div>' +
    '<div data-body style="display:none;margin-top:6px">' +
      '<button data-cap>采集并下载</button> ' +
      '<button data-copy>复制摘要</button>' +
      '<div data-status style="margin-top:5px;color:#555;overflow-wrap:anywhere">只读采集，不点击页面（v1.1.0 起递归同域 iframe）。</div>' +
      '<div style="margin-top:4px;color:#999">Alt+H 隐藏/显示</div>' +
    '</div>';
  const mount = () => { try { document.body.appendChild(panel); } catch (_) { setTimeout(mount, 500); } };
  mount();

  const body = panel.querySelector('[data-body]');
  const status = (t) => { panel.querySelector('[data-status]').textContent = t; };
  panel.querySelector('[data-dot]').onclick = () => {
    body.style.display = body.style.display === 'none' ? 'block' : 'none';
  };

  panel.querySelector('[data-cap]').onclick = async () => {
    status('采集中…');
    try {
      const r = await capture();
      const name = download(r);
      status(`已下载 ${name}（同域 ${r.sameOriginFrames.length} / 跨域 ${r.crossOriginFrames.length} 帧，视频题=${r.videoQuizFound}）`);
    } catch (e) {
      status('采集失败：' + (e && e.message));
    }
  };

  panel.querySelector('[data-copy]').onclick = async () => {
    try {
      const r = await capture();
      const summary = Object.entries(r.top.counts || {})
        .filter(([, v]) => v > 0)
        .map(([k, v]) => `${k}=${v}`)
        .join('  ');
      const quiz = [r.top, ...(r.sameOriginFrames || [])].find((p) => p && p.videoQuiz && p.videoQuiz.found);
      const text = [
        `url: ${r.top.url}`,
        `配置: ${summary}`,
        `控件: ${(r.top.controls || []).map((c) => c.text).join(' | ')}`,
        `同域帧: ${(r.sameOriginFrames || []).length}, 跨域帧: ${(r.crossOriginFrames || []).length}`,
        quiz ? `视频题: 提交按钮=${JSON.stringify((quiz.videoQuiz.submits || []).map((x) => x.class || x.id))}` : '视频题: 未发现',
      ].join('\n');
      await navigator.clipboard.writeText(text);
      status('摘要已复制');
    } catch (e) {
      status('复制失败：' + (e && e.message));
    }
  };

  addEventListener('keydown', (e) => {
    if (e.altKey && (e.key === 'h' || e.key === 'H')) {
      panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    }
  });

  try { globalThis.__CX_CAP__ = { capture, snapshot }; } catch (_) {}
})();
