/**
 * 学习通答题控制器（作业 / 章节测验）
 *
 * 实测 DOM（2026-10）：
 *   容器 .fanyaMarking / .TiMu
 *   单题 .questionLi
 *   选项 .mark_letter li[role="option"]
 *   确认弹窗 #popok / #popno
 *   提交区 .problem-fixedbar（旧版）/ 页面底部按钮（新版）
 *
 * 策略：
 *   1. 若页面已含正确答案（回顾态 .rightAnswerContent），直接采用
 *   2. 否则走 AI：先 coze（图片，绕字体加密），失败再 model（DeepSeek，纯文本题）
 *   3. 填完核对 DOM，再提交；提交后校验得分/标记
 */
(function () {
  "use strict";

  // 防重复注入
  if (window.CXAnswer) return;
  const state = {
    running: false,
    paused: false,
    results: [],
    logs: [],
    stats: { total: 0, answered: 0, submitted: 0, failed: 0 },
  };

  function log(msg, level) {
    const line = { ts: Date.now(), level: level || "info", msg: String(msg) };
    state.logs.push(line);
    if (state.logs.length > 500) state.logs.shift();
    (level === "error" ? console.warn : console.log)("[学习通·答题]", msg);
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ---------------- 答案归一化 ---------------- */

  /** 把 AI 返回的文本/数组统一成 {labels:[], texts:[]} */
  function normalizeAnswer(raw, question) {
    const out = { labels: [], texts: [], raw: raw };

    if (Array.isArray(raw)) {
      out.texts = raw.map((v) => String(v).trim()).filter(Boolean);
      // 若元素是纯字母，转 labels
      if (out.texts.every((t) => /^[A-Za-z]$/.test(t))) {
        out.labels = out.texts.map((t) => t.toUpperCase());
        out.texts = [];
      }
      return out;
    }

    const s = String(raw == null ? "" : raw).trim();

    // 1) 纯字母串：AC / A,C / A、C
    const letterOnly = s.match(/^[A-Za-z](?:\s*[,，、/\s]\s*[A-Za-z])*$/);
    if (letterOnly && question.options.length) {
      out.labels = s.split(/[,，、/\s]+/).filter(Boolean).map((t) => t.toUpperCase());
      return out;
    }

    // 2) "答案是 C" / "选 C" / "正确答案：C"
    const m1 = s.match(/(?:答案|选择|选)\s*[:：是为]?\s*([A-Za-z](?:\s*[,，、/]\s*[A-Za-z])*)/);
    if (m1 && question.options.length) {
      out.labels = m1[1].split(/[,，、/\s]+/).filter(Boolean).map((t) => t.toUpperCase());
      return out;
    }

    // 3) 与选项文本匹配
    if (question.options.length) {
      for (const opt of question.options) {
        const t = (opt.text || "").trim();
        if (t && (s === t || s.includes(t))) out.labels.push(opt.label);
      }
      if (out.labels.length) return out;
    }

    // 4) 当作填空/简答文本
    out.texts = [s];
    return out;
  }

  /* ---------------- 填充 ---------------- */

  function clickOption(question, label) {
    const opt = question.options.find((o) => o.label === label.toUpperCase());
    if (!opt) return false;
    try {
      opt.node.scrollIntoView({ block: "center" });
      // 移除 href 防止跳转（实测页面按钮常带 href）
      opt.node.removeAttribute("href");
      opt.node.click();
      return true;
    } catch (e) {
      log("点击选项 " + label + " 失败：" + e.message, "warn");
      return false;
    }
  }

  function fillText(question, values) {
    const li = question.node;
    // 富文本 / 输入框
    const inputs = [
      ...li.querySelectorAll('textarea, input[type="text"], .ans-input, [contenteditable="true"]'),
    ];
    if (!inputs.length) return false;

    let ok = 0;
    inputs.forEach((el, i) => {
      const v = values[i] ?? values[0] ?? "";
      try {
        if (el.isContentEditable) {
          el.innerText = v;
        } else {
          el.value = v;
        }
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        ok++;
      } catch (_) {}
    });
    return ok > 0;
  }

  /**
   * 回答单题。
   * 顺序：页面已有答案 → 超星 AI（若有）→ 自带模型（公式题带整题截图）
   */
  async function answerOne(question, { relationType, modelConfig, prefer = "auto" }) {
    // 1) 页面已有标准答案
    if (question.answers.right) {
      const norm = normalizeAnswer(question.answers.right, question);
      return { ...norm, source: "page" };
    }

    const hasCoze = typeof window.showAssistant === "function";
    const hasFormulaImage = question.stem.images.length > 0;
    let ai = null;

    // 2) 优先超星内置 AI（图片识别最准），但考试页往往没有
    if (hasCoze && prefer !== "model") {
      ai = await window.CXAI.askByCoze(question, relationType, { preferScreenshot: true });
      if (ai.ok) {
        const norm = normalizeAnswer(ai.text, question);
        norm.source = ai.via;
        norm.rawAi = ai.text;
        return norm;
      }
    }

    // 3) 自带模型：公式题必须带整题截图（DeepSeek V4.1 Flash 已验证支持视觉）
    let imageDataUrl = null;
    const needImage = hasFormulaImage || !hasCoze;
    if (needImage) {
      try {
        const img = await window.CXAI.grabQuestionImage(question, { preferScreenshot: true });
        imageDataUrl = img.dataUrl;
      } catch (e) {
        log("第 " + (question.index ?? question.seq + 1) + " 题取图失败：" + e.message, "warn");
      }
    }

    ai = await window.CXAI.askByModel(question, modelConfig, imageDataUrl);
    if (!ai || !ai.ok) {
      return {
        labels: [],
        texts: [],
        source: "none",
        reason: (ai && ai.reason) || "AI 无结果",
      };
    }
    const norm = normalizeAnswer(ai.text, question);
    norm.source = ai.via;
    norm.rawAi = ai.text;
    return norm;
  }

  /** 写入一题 */
  async function applyOne(question, answer) {
    if (answer.labels.length) {
      let n = 0;
      for (const label of answer.labels) {
        if (clickOption(question, label)) n++;
        await sleep(120);
      }
      return n > 0;
    }
    if (answer.texts.length) {
      return fillText(question, answer.texts);
    }
    return false;
  }

  /* ---------------- 提交 ---------------- */

  async function confirmDialog() {
    await sleep(600);
    for (const sel of ["#popok", ".popBottom .confirm", ".confirm", '[class*="confirm"]']) {
      const btn = document.querySelector(sel);
      if (btn && btn.offsetParent !== null) {
        try {
          btn.removeAttribute("href");
          btn.click();
          log("已点确认弹窗：" + sel);
          await sleep(500);
          return true;
        } catch (_) {}
      }
    }
    return false;
  }

  async function submitPaper() {
    const candidates = [
      ...document.querySelectorAll(
        'a, button, .btn, [class*="submit"], [onclick*="submit"]'
      ),
    ].filter((el) => /提交|交卷|保存并提交/.test((el.textContent || "").trim()) && el.offsetParent !== null);

    if (!candidates.length) {
      log("未找到提交按钮", "warn");
      return false;
    }
    const btn = candidates[0];
    try {
      btn.removeAttribute("href");
      btn.click();
      log("已点击提交：" + (btn.textContent || "").trim().slice(0, 12));
      await confirmDialog();
      return true;
    } catch (e) {
      log("提交失败：" + e.message, "error");
      return false;
    }
  }

  /** 提交后校验 */
  async function verifyAfterSubmit(timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 15000);
    while (Date.now() < deadline) {
      await sleep(800);
      const marked = document.querySelectorAll(".marking_dui, .marking_cuo, .mark_score");
      if (marked.length) {
        const rights = document.querySelectorAll(".marking_dui").length;
        const wrongs = document.querySelectorAll(".marking_cuo").length;
        const scores = [...document.querySelectorAll(".mark_score")].map((n) =>
          parseFloat((n.textContent || "0").replace(/[^\d.]/g, ""))
        );
        const total = scores.reduce((a, b) => a + (isNaN(b) ? 0 : b), 0);
        return { ok: true, rights, wrongs, totalScore: total };
      }
      if (/已完成|已提交|待批阅/.test(document.body.innerText)) {
        return { ok: true, text: "页面显示已完成/待批阅" };
      }
    }
    return { ok: false, reason: "提交后未检测到判分标记" };
  }

  /* ---------------- 主流程 ---------------- */

  async function run(options) {
    const opts = Object.assign(
      {
        relationType: window.CXAI.RELATION.WORK,
        modelConfig: null,
        prefer: "auto",
        // 默认**不自动提交**：填完只把答案写进页面，等用户核对后手动提交
        autoSubmit: false,
        maxQuestions: 200,
      },
      options || {}
    );

    if (state.running) return { ok: false, reason: "已在运行" };
    state.running = true;
    state.paused = false;
    state.results = [];

    const questions = window.CXModel.extractQuestions();
    state.stats.total = questions.length;
    log("扫描到 " + questions.length + " 道题，开始作答");

    for (const q of questions.slice(0, opts.maxQuestions)) {
      if (state.paused) {
        log("已暂停");
        break;
      }
      if (q.answers.mine) {
        log(`第 ${q.index ?? q.seq + 1} 题已有作答，跳过`);
        continue;
      }

      const answer = await answerOne(q, opts);
      const applied = await applyOne(q, answer);
      const rec = {
        seq: q.seq,
        index: q.index,
        type: q.type,
        source: answer.source,
        labels: answer.labels,
        texts: answer.texts,
        applied,
        reason: answer.reason,
      };
      state.results.push(rec);

      if (applied) {
        state.stats.answered++;
        log(
          `第 ${q.index ?? q.seq + 1} 题 [${q.type}] ← ${answer.source}: ` +
            (answer.labels.join(",") || answer.texts.join(" / ") || "-")
        );
      } else {
        state.stats.failed++;
        log(`第 ${q.index ?? q.seq + 1} 题填充失败：${answer.reason || "无可用答案"}`, "error");
      }
      await sleep(600);
    }

    let submitResult = null;
    if (opts.autoSubmit && state.stats.answered > 0 && !state.paused) {
      const submitted = await submitPaper();
      state.stats.submitted = submitted ? 1 : 0;
      submitResult = submitted ? await verifyAfterSubmit() : { ok: false, reason: "提交未成功" };
      log("提交结果：" + JSON.stringify(submitResult));
    }

    state.running = false;
    return {
      ok: true,
      stats: { ...state.stats },
      results: state.results,
      submitResult,
      logs: state.logs.slice(-50),
    };
  }

  window.CXAnswer = {
    run,
    pause() {
      state.paused = true;
      return { ok: true };
    },
    status() {
      return {
        running: state.running,
        paused: state.paused,
        stats: { ...state.stats },
        logs: state.logs.slice(-40),
      };
    },
    // 供调试
    normalizeAnswer,
    submitPaper,
    verifyAfterSubmit,
    answerOne,
  };
})();
