/**
 * 学习通 AI 桥
 *
 * 两条取答案的路径：
 *
 *   A. 超星内置 AI 助手（Coze bot）—— 传题目截图，视觉模型现场解题
 *      优点：绕开字体加密；不需要提交；随时可用
 *      缺点：答案在 cozeIframe 内部渲染，需配合 xuexitong-coze-hook.js 采集
 *
 *   B. 扩展自带的 OpenAI 兼容模型（DeepSeek / GLM 等）—— 传题干文本
 *      优点：直接拿到结构化回答
 *      缺点：题干被字体加密时文本不可用，只适用于纯文本题
 *
 * 实测关键（2026-10）：
 *   - showAssistant(img, sourceInfo) 的 sourceInfo 必须是 JSON **字符串**，
 *     传对象会导致 CozeBotSDK.init 内 sourceInfo.trim() 抛错并被静默吞掉。
 *   - 无效图片（如 1×1）不会触发任何后端请求，必须传真实题目图。
 */
(function () {
  "use strict";

  // 防重复注入（popup 可能在页面已注入后再次 executeScript）
  if (window.CXAI) return;

  const COZE = {
    appId: "1192651262850",
    botId: "7429626930406326309",
  };

  /** 关系类型 */
  const RELATION = {
    WORK: "0",   // 作业
    EXAM: "1",   // 考试
    QUIZ: "2",   // 测验
    SELF: "3",   // 自测
  };

  const pending = new Map(); // objectId -> resolver

  /* ---------------- 消息通道：等待 coze-hook 回传 ---------------- */
  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.__cxai !== true) return;
    if (d.kind === "answer") {
      const key = d.objectId || "__last__";
      const r = pending.get(key) || pending.get("__last__");
      if (r) {
        clearTimeout(r.timer);
        pending.delete(key);
        pending.delete("__last__");
        r.resolve(d.text || "");
      }
    }
  });

  function waitForAnswer(objectId, timeoutMs) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(objectId);
        pending.delete("__last__");
        resolve("");
      }, timeoutMs || 60000);
      if (objectId) pending.set(objectId, { resolve, timer });
      pending.set("__last__", { resolve, timer });
    });
  }

  /* ---------------- 图片获取 ---------------- */

  /** 通过 background 抓图并转 dataURL（避开 content script 的 CORS 限制） */
  async function fetchImageAsDataUrl(url) {
    const res = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: "fetchImageAsDataUrl", url }, (r) => {
        if (chrome.runtime.lastError) return resolve({ success: false, error: chrome.runtime.lastError.message });
        resolve(r || { success: false, error: "no response" });
      });
    });
    if (!res.success) throw new Error(res.error || "取图失败");
    return res.dataUrl;
  }

  /** 方法 B：题目自带图片 */
  async function imageFromQuestion(question) {
    const src = question?.stem?.images?.[0];
    if (!src) return null;
    return await fetchImageAsDataUrl(src);
  }

  /** 方法 A：截图 + 裁剪（需要 background 的 captureVisibleTab） */
  async function imageFromScreenshot(node) {
    if (!node) throw new Error("缺少题目节点");
    node.scrollIntoView({ block: "center", behavior: "instant" });
    await new Promise((r) => setTimeout(r, 250));
    const rect = node.getBoundingClientRect();
    const cap = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: "captureVisibleTab" }, (r) => {
        if (chrome.runtime.lastError) return resolve({ success: false, error: chrome.runtime.lastError.message });
        resolve(r || { success: false, error: "no response" });
      });
    });
    if (!cap.success) throw new Error(cap.error || "截屏失败");
    return await cropDataUrl(cap.dataUrl, rect);
  }

  async function cropDataUrl(fullDataUrl, rect) {
    const blob = await (await fetch(fullDataUrl)).blob();
    const bmp = await createImageBitmap(blob);
    const dpr = window.devicePixelRatio || 1;
    const x = Math.max(0, Math.round(rect.x * dpr));
    const y = Math.max(0, Math.round(rect.y * dpr));
    const w = Math.min(bmp.width - x, Math.round(rect.width * dpr));
    const h = Math.min(bmp.height - y, Math.round(rect.height * dpr));
    const canvas = new OffscreenCanvas(Math.max(1, w), Math.max(1, h));
    canvas.getContext("2d").drawImage(bmp, x, y, w, h, 0, 0, w, h);
    const out = await canvas.convertToBlob({ type: "image/png" });
    return await new Promise((resolve) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.readAsDataURL(out);
    });
  }

  /**
   * 统一取图。
   * 默认走**整题截图**（含题干 + 全部选项），因为：
   *   - 公式是 <img>，题干文本会残缺
   *   - 只截题干图会丢选项
   * 只有在截图失败时才退回题干图片。
   */
  async function grabQuestionImage(question, { preferScreenshot = true } = {}) {
    if (preferScreenshot) {
      try {
        const d = await imageFromScreenshot(question.node);
        if (d) return { dataUrl: d, via: "screenshot" };
      } catch (_) {}
    }
    const d = await imageFromQuestion(question);
    if (d) return { dataUrl: d, via: "question-image" };
    throw new Error("无法获取题目图片：截图与题干图片均失败");
  }

  /* ---------------- 路径 A：超星 AI 助手 ---------------- */

  function buildSourceInfo(params, relationType, questionId) {
    return JSON.stringify({
      serverName: "mooc1",
      businessTag: "question_assistant",
      extraData: {
        courseId: params.courseId || "",
        clazzId: params.clazzId || "",
        personId: params.cpi || "",
        relationType: String(relationType),
        relationId: String(params.workId || params.examId || ""),
        questionType: "0",
        questionTypeId: "0",
        questionId: questionId || "0",
      },
    });
  }

  /**
   * 调超星 AI 助手，等 coze-hook 回传答案文本。
   * @returns {Promise<{ok:boolean, text:string, via:string, reason?:string}>}
   */
  async function askByCoze(question, relationType, opts) {
    if (typeof window.showAssistant !== "function") {
      return { ok: false, text: "", via: "coze", reason: "showAssistant 不存在，页面未加载 AI 助手" };
    }
    const params = window.CXModel.parseParams();
    let img;
    try {
      img = await grabQuestionImage(question, opts);
    } catch (e) {
      return { ok: false, text: "", via: "coze", reason: "取图失败：" + e.message };
    }

    const sourceInfo = buildSourceInfo(params, relationType, question.qid);
    const waiter = waitForAnswer(question.qid, opts?.timeoutMs || 60000);

    try {
      window.showAssistant(img.dataUrl, sourceInfo);
    } catch (e) {
      return { ok: false, text: "", via: "coze", reason: "调用失败：" + e.message };
    }

    const text = await waiter;
    return {
      ok: !!text,
      text,
      via: "coze/" + img.via,
      reason: text ? undefined : "AI 未在超时前返回文本（检查 coze-hook 是否注入）",
    };
  }

  /* ---------------- 路径 B：自带模型（DeepSeek 等） ---------------- */

  function buildAnswerPrompt(question, hasImage) {
    const typeMap = {
      single: "单选题",
      multiple: "多选题",
      judge: "判断题",
      fill: "填空题",
      short: "简答题",
      calc: "计算题",
    };
    const lines = [];
    lines.push("题型：" + (typeMap[question.type] || question.type || "未知"));
    lines.push("题干：" + question.stem.text);
    if (question.options.length) {
      lines.push("选项：");
      question.options.forEach((o) => lines.push("  " + o.label + ". " + o.text));
    }
    if (hasImage) {
      lines.push("");
      lines.push("【重要】题目中包含数学公式，已随消息附带题目截图。");
      lines.push("请以截图中的完整题目为准作答，不要依赖上面可能残缺的文字。");
    } else if (question.stem.images.length) {
      lines.push("");
      lines.push("【注意】题干中的公式无法转成文字，请根据选项与上下文推断最可能的答案；不确定时给出置信度。");
    }
    lines.push("");
    lines.push('只返回 JSON，不要解释。格式：{"answer":"<答案>","confidence":<0-1>}');
    lines.push("作答规则：");
    lines.push("1. 选择题：只给字母，多选连写如 \"AC\"；字母是截图中显示的 A/B/C/D。");
    lines.push("2. 判断题：只给「对」或「错」两个字。");
    lines.push("3. 填空题：直接给数值或表达式；有多个解时用英文逗号分隔，不要用「或」。");
    lines.push("4. 简答题：给一段可直接提交的文字说明，不要分点符号。");
    lines.push("5. 不要用 LaTeX 包裹（不要 \\( \\) 或 $ $），不要加引号。");
    lines.push("6. 保持最简形式，化简到底。");
    return lines.join("\n");
  }

  /**
   * 用扩展配置的模型答题。
   * @param {string} [imageDataUrl] 题目截图 dataURL；有值时走多模态（DeepSeek V4.1 Flash 已验证支持）
   */
  async function askByModel(question, modelConfig, imageDataUrl) {
    const prompt = buildAnswerPrompt(question, !!imageDataUrl);
    const res = await new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { action: "callAI", config: modelConfig, prompt, imageDataUrl: imageDataUrl || null },
        (r) => {
          if (chrome.runtime.lastError) return resolve({ success: false, error: chrome.runtime.lastError.message });
          resolve(r || { success: false, error: "no response" });
        }
      );
    });
    if (!res.success) return { ok: false, text: "", via: "model", reason: res.error };
    const raw = String(res.data || "");
    const parsed = parseModelAnswer(raw);
    return { ok: !!parsed, text: parsed, via: imageDataUrl ? "model+image" : "model", raw };
  }

  /**
   * 解析模型回答。
   * 实测问题：模型有时返回被截断的 JSON（如 {"answer":"\(x-3y+z+2=0\)" 缺右括号），
   * 直接 JSON.parse 会失败，把原始 JSON 当答案填进输入框。
   * 因此按「完整JSON → 正则提取 → 字母串 → 原文」四级降级。
   */
  function parseModelAnswer(raw) {
    const s = String(raw == null ? "" : raw).trim();
    if (!s) return "";

    // 1) 完整 JSON
    const jsonMatch = s.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const j = JSON.parse(jsonMatch[0]);
        const v = extractAnswerField(j);
        if (v != null && String(v).trim()) return v;
      } catch (_) {}
    }

    // 2) 截断的 JSON：正则抠 "answer" 字段
    const strField = s.match(/"answer"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (strField) {
      const v = cleanAnswerText(unescapeJsonString(strField[1]));
      if (v) return v;
    }
    const arrField = s.match(/"answer"\s*:\s*\[([\s\S]*?)\]/);
    if (arrField) {
      const parts = [...arrField[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)]
        .map((m) => cleanAnswerText(unescapeJsonString(m[1])))
        .filter(Boolean);
      if (parts.length) return parts;
    }

    // 3) 纯字母串（选择题）
    const letters = s.match(/\b[A-Z]{1,8}\b/g);
    if (letters && letters.length && !/[{}"]/.test(s)) {
      return letters[letters.length - 1];
    }

    // 4) 原样返回（去掉可能的 LaTeX 包裹和引号）
    return cleanAnswerText(s);
  }

  function extractAnswerField(obj) {
    if (obj == null) return null;
    const v = obj.answer != null ? obj.answer : obj['答案'] != null ? obj['答案'] : null;
    if (Array.isArray(v)) {
      const parts = v.map((x) => cleanAnswerText(String(x))).filter(Boolean);
      return parts.length ? parts : null;
    }
    if (v != null) return cleanAnswerText(String(v));
    return null;
  }

  function unescapeJsonString(v) {
    return String(v)
      .replace(/\\"/g, '"')
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\\//g, "/")
      .replace(/\\\\/g, "\\");
  }

  /** LaTeX → 普通数学符号，便于直接填进学习通输入框 */
  function latexToPlain(t) {
    let s = String(t);
    s = s.replace(/\\pm\b/g, "±").replace(/\\mp\b/g, "∓");
    s = s.replace(/\\times\b/g, "×").replace(/\\cdot\b/g, "·").replace(/\\div\b/g, "÷");
    s = s.replace(/\\pi\b/g, "π").replace(/\\alpha\b/g, "α").replace(/\\beta\b/g, "β");
    s = s.replace(/\\theta\b/g, "θ").replace(/\\lambda\b/g, "λ").replace(/\\infty\b/g, "∞");
    s = s.replace(/\\leq?\b/g, "≤").replace(/\\geq?\b/g, "≥").replace(/\\neq\b/g, "≠");
    s = s.replace(/\\sqrt\s*\{([^{}]*)\}/g, "√$1");
    s = s.replace(/\\sqrt\s*([A-Za-z0-9])/g, "√$1");
    s = s.replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, "($1)/($2)");
    s = s.replace(/\^\{([^{}]*)\}/g, "^$1");
    s = s.replace(/_\{([^{}]*)\}/g, "_$1");
    s = s.replace(/\\left|\\right/g, "");
    s = s.replace(/\\[,;:!]/g, " ");
    s = s.replace(/\\[A-Za-z]+/g, ""); // 剩余未知命令
    s = s.replace(/[{}]/g, "");
    return s.replace(/\s+/g, " ").trim();
  }

  /** 去掉 LaTeX 行内包裹 \( \) 、$ $ ，以及包裹引号，并转成普通符号 */
  function cleanAnswerText(v) {
    let t = String(v == null ? "" : v).trim();

    // 1) 先剥掉行内包裹
    t = t.replace(/^\\\(/, "").replace(/\\\)$/, "").trim();
    t = t.replace(/^\$+|\$+$/g, "").trim();

    // 2) LaTeX 命令要在花括号**还在**的时候转换，
    //    否则 \frac{1}{2} 结尾的 } 会被下一步误删。
    if (/\\[A-Za-z]/.test(t)) t = latexToPlain(t);

    // 3) 最后清包裹引号。
    //    注意：不能无条件删首尾花括号，那会破坏尚未转换的 LaTeX 结构。
    t = t.replace(/^["'`]+|["'`]+$/g, "").trim();

    return t.trim();
  }

  window.CXAI = {
    COZE,
    RELATION,
    fetchImageAsDataUrl,
    grabQuestionImage,
    buildSourceInfo,
    askByCoze,
    askByModel,
    buildAnswerPrompt,
    parseModelAnswer,
  };
})();
