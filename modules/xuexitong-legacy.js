/**
 * 学习通「章节练习 / 旧版作业」适配层（doHomeWorkNew）
 *
 * 实测结构（2026-10，6.2练习题 11 题）：
 *
 *   题目容器：.TiMu.newTiMu         （不是 .questionLi）
 *   题型标识：data 属性 —— 2=填空 3=判断 4=简答
 *   题干：.Zy_TItle .font-cxsecret  （字体加密 + 公式图片）
 *   填空/简答：UEditor 富文本
 *        <div class="blankItemInp">
 *          <div class="textDIV"><div class="edui-editor" id="edui457">
 *            <iframe> → body[contenteditable="true"]
 *   判断题：
 *        <li onclick="addChoice(this)" qid=… qtype="3" role="radio">
 *          <span class="num_option" name="answer<qid>" data="true">A</span>
 *          <a class="after">对</a>
 *        </li>
 *   答案存储：<input type="hidden" name="answer<qid>">
 *   提交：.btnSubmit.workBtnIndex    暂存：.btnSave.workBtnIndex
 *
 * 难点：题目藏在 studentstudy → knowledge/cards → ananas/modules/work → doHomeWorkNew
 *      四层 iframe 里，且每层跨域状态不同，必须递归访问同域 contentDocument。
 */
(function () {
  "use strict";

  if (window.CXLegacy) return;

  function isDoc(node) {
    return !!node && typeof node.querySelectorAll === "function" && !!node.body;
  }

  /** 递归收集所有含题目的文档 */
  function findQuestionDocs() {
    const out = [];
    const walk = (doc, depth) => {
      if (depth > 6) return;
      try {
        if (doc.querySelector(".TiMu, .questionLi, .answerBg")) out.push(doc);
      } catch (_) {}
      let frames = [];
      try { frames = [...doc.querySelectorAll("iframe")]; } catch (_) {}
      for (const fr of frames) {
        let d = null;
        try { d = fr.contentDocument; } catch (_) {}
        if (isDoc(d)) walk(d, depth + 1);
      }
    };
    walk(document, 0);
    return out;
  }

  /** 元素在顶层窗口中的绝对矩形（用于整页截图裁剪） */
  function absoluteRect(node, doc) {
    const r = node.getBoundingClientRect();
    let x = r.x, y = r.y;
    let win = (doc || node.ownerDocument || document).defaultView;
    let guard = 0;
    while (win && win !== window && guard++ < 8) {
      const fe = win.frameElement;
      if (!fe) break;
      const fr = fe.getBoundingClientRect();
      x += fr.x;
      y += fr.y;
      win = win.parent;
    }
    return { x, y, width: r.width, height: r.height };
  }

  /* ---------------- 题型判定 ---------------- */

  /**
   * 题型由 .TiMu 的 data 属性标识（实测）：
   *   0 = 单选   1 = 多选   2 = 填空   3 = 判断   4 = 简答
   */
  const DATA_TYPE = {
    "0": "single",
    "1": "multiple",
    "2": "fill",
    "3": "judge",
    "4": "short",
  };

  const CHOICE_TYPES = { single: 1, multiple: 1 };

  function detectType(timu) {
    const d = timu.getAttribute("data");
    if (DATA_TYPE[d]) return DATA_TYPE[d];
    const head = (timu.querySelector(".newZy_TItle")?.textContent || "").trim();
    if (/填空/.test(head)) return "fill";
    if (/判断/.test(head)) return "judge";
    if (/简答|问答|论述/.test(head)) return "short";
    if (/单选/.test(head)) return "single";
    if (/多选/.test(head)) return "multiple";
    return "unknown";
  }

  function clean(v) {
    return String(v == null ? "" : v)
      .replace(/[\u200b-\u200f\ufeff]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function readQid(timu) {
    // 1) 判断题的 li 带 qid
    const li = timu.querySelector("li[qid]");
    if (li) return li.getAttribute("qid");
    // 2) 隐藏域的 name 通常形如 answertype214845208 / answer214845211，取尾部数字
    const hidden = timu.querySelector(
      'input[type="hidden"][name^="answertype"], input[type="hidden"][name^="answer"]'
    );
    if (hidden) {
      const m = (hidden.name || "").match(/(\d+)$/);
      if (m) return m[1];
    }
    return "";
  }

  /* ---------------- 题干与选项 ---------------- */

  function readStem(timu) {
    const holder = timu.querySelector(".Zy_TItle .font-cxsecret, .Zy_TItle");
    if (!holder) return { text: "", images: [], html: "" };
    const clone = holder.cloneNode(true);
    clone.querySelectorAll(".newZy_TItle").forEach((n) => n.remove());
    const images = [];
    clone.querySelectorAll("img").forEach((img) => {
      let src = img.getAttribute("data-original") || img.src || "";
      src = src.replace("375_1024", "origin").replace("750_1024", "origin");
      if (src) images.push(src);
    });
    return { text: clean(clone.textContent), images, html: clone.innerHTML || "" };
  }

  /**
   * 选项读取：判断题 / 单选 / 多选共用同一套 li 结构
   *   <li onclick="addChoice(this)" qid=… qtype=… role="radio|checkbox">
   *     <span class="num_option" data="A">A</span>
   *     <a class="after">选项内容（可能是图片）</a>
   *   </li>
   */
  function readChoiceOptions(timu) {
    return [...timu.querySelectorAll('li[qid][role="radio"], li[qid][role="checkbox"], li[onclick*="addChoice"]')].map((li, i) => {
      const num = li.querySelector(".num_option");
      const after = li.querySelector(".after");
      const label = clean(num?.textContent) || String.fromCharCode(65 + i);
      const imgs = [...(after ? after.querySelectorAll("img") : [])].map((img) =>
        (img.getAttribute("data-original") || img.src || "")
          .replace("375_1024", "origin")
          .replace("750_1024", "origin")
      ).filter(Boolean);
      return {
        index: i,
        label: label.toUpperCase(),
        value: num?.getAttribute("data") || "",
        text: clean(after?.textContent),
        images: imgs,
        raw: clean(li.textContent),
        node: li,
      };
    });
  }

  /* ---------------- 编辑器 ---------------- */

  /** 找到题目里的 UEditor 编辑区容器集合 */
  function findEditors(timu) {
    const list = [...timu.querySelectorAll(".edui-editor")];
    // 有的页面只有 1 个，有的多空多个
    return list.map((ed) => {
      const iframe = ed.querySelector("iframe");
      let body = null;
      try { body = iframe?.contentDocument?.body || null; } catch (_) {}
      return { container: ed, iframe, body };
    });
  }

  /**
   * 往 UEditor 写内容并触发同步。
   *
   * 关键：必须走浏览器原生编辑命令（execCommand('insertText')），
   * 直接改 innerHTML 会绕过编辑器内部状态，UEditor 不会记录内容、提交时读不到。
   * 思路参考「Paste Unlock & Simulated Typing」的原生插入方案。
   */
  function fillEditor(ed, text) {
    const value = String(text == null ? "" : text);
    const body = ed.body;
    if (!body) return { ok: false, reason: "未找到编辑区 iframe" };

    const doc = body.ownerDocument;
    const win = doc.defaultView || window;

    try {
      // 1) 聚焦编辑区（焦点在 iframe 内才能执行编辑命令）
      try { win.focus(); } catch (_) {}
      try { body.focus(); } catch (_) {}

      // 2) 选中全部内容，准备整体替换
      const sel = doc.getSelection();
      const range = doc.createRange();
      range.selectNodeContents(body);
      sel.removeAllRanges();
      sel.addRange(range);

      // 3) 原生编辑命令插入
      let inserted = false;
      try {
        inserted = doc.execCommand("insertText", false, value);
      } catch (_) {}

      // 4) 兜底：execCommand 失败或内容不符时写 DOM
      const got = (body.innerText || "").replace(/\u200b/g, "").trim();
      if (!inserted || got !== value.trim()) {
        body.innerHTML = "";
        const parts = value.split("\n");
        parts.forEach((line, i) => {
          if (i) body.appendChild(doc.createElement("br"));
          if (line) body.appendChild(doc.createTextNode(line));
        });
      }

      // 5) 派发原生输入事件（用 iframe 自己的构造器）
      try {
        body.dispatchEvent(
          new win.InputEvent("input", {
            bubbles: true,
            composed: true,
            inputType: "insertText",
            data: value,
          })
        );
      } catch (_) {
        try { body.dispatchEvent(new win.Event("input", { bubbles: true })); } catch (_) {}
      }
      try { body.dispatchEvent(new win.Event("keyup", { bubbles: true })); } catch (_) {}
      try { body.dispatchEvent(new win.Event("blur", { bubbles: true })); } catch (_) {}
    } catch (e) {
      return { ok: false, reason: "写入编辑区失败：" + e.message };
    }

    // 6) 同步到 textarea（UEditor 提交时读 textarea）
    const textareaId = (ed.container.id || "").replace(/^edui/, "");
    const tdoc = ed.container.ownerDocument;
    let ta = null;
    if (textareaId) {
      try { ta = tdoc.querySelector('textarea[name="' + textareaId + '"]'); } catch (_) {}
      if (!ta) { try { ta = tdoc.getElementById(textareaId); } catch (_) {} }
    }
    if (!ta) {
      ta = ed.container.closest(".TiMu")?.querySelector("textarea") || null;
    }
    if (ta) {
      try {
        ta.value = value;
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        ta.dispatchEvent(new Event("change", { bubbles: true }));
      } catch (_) {}
    }

    // 7) 若 UEditor 实例可定位，再走一次官方 API 兜底
    try {
      const UE = (ed.container.ownerDocument.defaultView || {}).UE;
      if (UE && UE.instants) {
        for (const key in UE.instants) {
          const inst = UE.instants[key];
          if (inst && inst.iframe && inst.iframe.dom === ed.iframe) {
            if (typeof inst.setContent === "function") inst.setContent(value);
            break;
          }
        }
      }
    } catch (_) {}

    const finalText = (ed.body?.innerText || "").replace(/\u200b/g, "").trim();
    return { ok: finalText === value.trim() || finalText.length > 0, text: finalText };
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /* ---------------- 提取 ---------------- */

  function extract(docs) {
    const list = docs || findQuestionDocs();
    const out = [];
    let seq = 0;
    for (const doc of list) {
      for (const timu of doc.querySelectorAll(".TiMu")) {
        const type = detectType(timu);
        const stem = readStem(timu);
        const qid = readQid(timu);
        const editors = type === "fill" || type === "short" ? findEditors(timu) : [];
        // 判断题 / 单选 / 多选 共用 li 选项结构
        const options =
          type === "judge" || CHOICE_TYPES[type] ? readChoiceOptions(timu) : [];
        const hidden = timu.querySelector('input[type="hidden"][name^="answer"]');
        const numEl = timu.querySelector(".Zy_TItle i");
        out.push({
          seq: seq++,
          qid,
          index: numEl ? parseInt(clean(numEl.textContent), 10) || null : null,
          type,
          score: null,
          titleRaw: clean(timu.querySelector(".newZy_TItle")?.textContent || ""),
          stem,
          options,
          answers: { mine: clean(hidden?.value || ""), right: "", score: "", judge: "" },
          node: timu,
          doc,
          editors,
          _legacy: true,
        });
      }
    }
    return out;
  }

  /* ---------------- 填充 ---------------- */

  /** 判断题：点 li */
  function fillJudge(question, label) {
    const target = question.options.find(
      (o) => o.label === String(label).toUpperCase()
    );
    if (!target) return false;
    try {
      target.node.click();
      return true;
    } catch (e) {
      return false;
    }
  }

  /** 判断题：按"对/错"文本填 */
  function fillJudgeByText(question, text) {
    const t = String(text || "");
    const wantTrue = /^(对|正确|是|√|true|T)$/i.test(t.trim()) || /对/.test(t);
    const target = question.options.find((o) =>
      wantTrue ? o.value === "true" : o.value === "false"
    );
    if (!target) return fillJudge(question, wantTrue ? "A" : "B");
    try {
      target.node.click();
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * 选择题：按答案里的字母逐个点击
   * 支持 "C"、"AC"、"A,C"、"答案是 C" 等形态
   */
  function fillChoice(question, answer) {
    const raw = String(answer == null ? "" : answer).toUpperCase();
    // 优先匹配 "答案/选" 后面的连续字母；否则取所有独立大写字母
    let letters = [];
    const m = raw.match(/(?:答案|选择|选)\s*[:：是为]?\s*([A-Z](?:\s*[,，、/]?\s*[A-Z])*)/);
    if (m) letters = m[1].replace(/[^A-Z]/g, "").split("");
    if (!letters.length) letters = raw.replace(/[^A-Z]/g, "").split("");
    // 去掉常见的干扰词（TRUE/FALSE 等已由判断题处理）
    const valid = [...new Set(letters)].filter((L) => question.options.some((o) => o.label === L));
    if (!valid.length) return false;
    let n = 0;
    for (const L of valid) {
      if (fillJudge(question, L)) n++;
    }
    return n > 0;
  }

  /** 填空/简答：写第一个编辑器 */
  function fillText(question, text) {
    if (!question.editors || !question.editors.length) return false;
    const r = fillEditor(question.editors[0], text);
    return r.ok;
  }

  /* ---------------- 提交 ---------------- */

  function findSubmit(docs) {
    const list = docs || findQuestionDocs();
    for (const doc of list) {
      const btn = doc.querySelector(".btnSubmit, a.btnSubmit");
      if (btn) return { btn, doc };
    }
    return null;
  }

  function submit() {
    const hit = findSubmit();
    if (!hit) return { ok: false, reason: "未找到提交按钮 .btnSubmit" };
    try {
      hit.btn.click();
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }

  function saveDraft() {
    const list = findQuestionDocs();
    for (const doc of list) {
      const btn = doc.querySelector(".btnSave");
      if (btn) {
        try { btn.click(); return { ok: true }; } catch (e) { return { ok: false, reason: e.message }; }
      }
    }
    return { ok: false, reason: "未找到暂存按钮 .btnSave" };
  }

  /** 统计作答情况 */
  function stats() {
    const qs = extract();
    return {
      total: qs.length,
      byType: qs.reduce((a, q) => (a[q.type] = (a[q.type] || 0) + 1, a), {}),
      answered: qs.filter((q) => {
        const hidden = q.node.querySelector('input[type="hidden"][name^="answer"]');
        // 判断题 / 选择题：看隐藏域
        if (q.type === "judge" || CHOICE_TYPES[q.type]) {
          return !!(hidden && hidden.value);
        }
        // 填空 / 简答：看编辑器内容
        return (q.editors || []).some((e) => {
          const t = (e.body?.innerText || "").replace(/\u200b/g, "").trim();
          return t.length > 0;
        });
      }).length,
    };
  }

  /* ---------------- 截图（跨 iframe 坐标换算） ---------------- */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function sendBg(msg) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (r) => {
        if (chrome.runtime.lastError) return resolve({ success: false, error: chrome.runtime.lastError.message });
        resolve(r || { success: false, error: "no response" });
      });
    });
  }

  /** 逐层滚动：让目标元素真正进入**顶层**视口 */
  function forceScrollTo(node, doc) {
    let current = node;
    let currentDoc = doc || node.ownerDocument || document;
    let guard = 0;
    while (guard++ < 8) {
      try { current.scrollIntoView({ block: "center", behavior: "auto" }); } catch (_) {}
      const win = currentDoc.defaultView;
      if (!win || win === window) break;
      const fe = win.frameElement;
      if (!fe) break;
      current = fe;
      currentDoc = fe.ownerDocument;
    }
    // 最后再对顶层窗口补一次
    try { node.scrollIntoView({ block: "center", behavior: "auto" }); } catch (_) {}
  }

  /** 确认元素落在顶层视口内；不在就反复调整 */
  async function ensureVisible(question, tries) {
    const max = tries || 6;
    for (let i = 0; i < max; i++) {
      const r = absoluteRect(question.node, question.doc);
      const fitsY = r.y >= 4 && r.y + Math.min(r.height, window.innerHeight - 8) <= window.innerHeight;
      const fitsX = r.x >= 0 && r.x < window.innerWidth;
      if (fitsY && fitsX) return { ok: true, rect: r, tries: i };
      forceScrollTo(question.node, question.doc);
      await sleep(350);
    }
    const r = absoluteRect(question.node, question.doc);
    return { ok: false, rect: r, tries: max };
  }

  /** 保留旧接口：只做滚动 */
  function revealNode(node, doc) {
    forceScrollTo(node, doc);
  }

  async function cropDataUrl(fullDataUrl, rect) {
    const blob = await (await fetch(fullDataUrl)).blob();
    const bmp = await createImageBitmap(blob);
    const dpr = window.devicePixelRatio || 1;
    const x = Math.max(0, Math.round(rect.x * dpr));
    const y = Math.max(0, Math.round(rect.y * dpr));
    const w = Math.min(bmp.width - x, Math.round(rect.width * dpr));
    const h = Math.min(bmp.height - y, Math.round(rect.height * dpr));
    if (w <= 0 || h <= 0) throw new Error("裁剪区域无效");
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext("2d").drawImage(bmp, x, y, w, h, 0, 0, w, h);
    const out = await canvas.convertToBlob({ type: "image/png" });
    return await new Promise((resolve) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.readAsDataURL(out);
    });
  }

  async function screenshotQuestion(question) {
    const vis = await ensureVisible(question);
    if (!vis.ok) {
      throw new Error(
        "题目无法滚动进视口（y=" + Math.round(vis.rect.y) + "），跳过截图"
      );
    }
    await sleep(200);
    const cap = await sendBg({ action: "captureVisibleTab" });
    if (!cap.success) throw new Error(cap.error || "截屏失败");
    const rect = absoluteRect(question.node, question.doc);
    // 再钳一次，确保不越界
    const clamped = {
      x: Math.max(0, rect.x),
      y: Math.max(0, rect.y),
      width: Math.min(rect.width, window.innerWidth - Math.max(0, rect.x)),
      height: Math.min(rect.height, window.innerHeight - Math.max(0, rect.y)),
    };
    if (clamped.width < 20 || clamped.height < 20) {
      throw new Error("裁剪区域过小（" + Math.round(clamped.width) + "×" + Math.round(clamped.height) + "）");
    }
    return await cropDataUrl(cap.dataUrl, clamped);
  }

  /* ---------------- 主流程 ---------------- */

  /**
   * 作答整页练习。
   * @param {object} opts { modelConfig, perQuestionTimeoutMs, maxQuestions }
   */
  async function run(opts) {
    const options = Object.assign(
      {
        modelConfig: null,
        perQuestionTimeoutMs: 45000,
        maxQuestions: 100,
        includeShortAnswer: true,
      },
      opts || {}
    );

    const questions = extract();
    const results = [];
    const stats = { total: questions.length, answered: 0, failed: 0, skipped: 0 };

    for (const q of questions.slice(0, options.maxQuestions)) {
      // 判断题：已有答案就跳过
      if (q.type === "judge" && q.answers.mine) {
        stats.skipped++;
        results.push({ seq: q.seq, index: q.index, type: q.type, source: "existing", applied: true });
        continue;
      }
      if (q.type === "short" && !options.includeShortAnswer) {
        stats.skipped++;
        continue;
      }

      let img = null;
      try {
        img = await screenshotQuestion(q);
      } catch (e) {
        results.push({ seq: q.seq, index: q.index, type: q.type, error: "取图失败：" + e.message });
        stats.failed++;
        continue;
      }

      let ai = null;
      try {
        ai = await Promise.race([
          window.CXAI.askByModel(q, options.modelConfig, img),
          sleep(options.perQuestionTimeoutMs).then(() => ({ ok: false, reason: "超时" })),
        ]);
      } catch (e) {
        ai = { ok: false, reason: e.message };
      }

      if (!ai || !ai.ok) {
        results.push({
          seq: q.seq, index: q.index, type: q.type,
          error: (ai && ai.reason) || "AI 无结果",
        });
        stats.failed++;
        continue;
      }

      let applied = false;
      if (q.type === "judge") {
        applied = fillJudgeByText(q, ai.text);
      } else if (CHOICE_TYPES[q.type]) {
        applied = fillChoice(q, ai.text);
      } else {
        applied = fillText(q, String(ai.text || "").trim());
      }

      if (applied) stats.answered++;
      else stats.failed++;

      results.push({
        seq: q.seq, index: q.index, type: q.type,
        answer: String(ai.text || "").slice(0, 80),
        via: ai.via, applied,
      });

      await sleep(400);
    }

    return { stats, results };
  }

  window.CXLegacy = {
    findQuestionDocs,
    absoluteRect,
    extract,
    stats,
    fillJudge,
    fillJudgeByText,
    fillChoice,
    fillText,
    fillEditor,
    findEditors,
    submit,
    saveDraft,
    detectType,
    ensureVisible,
    forceScrollTo,
    screenshotQuestion,
    revealNode,
    run,
  };
})();
