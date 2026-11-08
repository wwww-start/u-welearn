/**
 * 学习通页面模型
 *
 * 负责识别页面类型并提取题目结构。
 * 依据 2026-10 实测的真实 DOM：
 *
 *   试卷/作业容器: .fanyaMarking / .TiMu
 *   单题容器:     .questionLi  （id="question<qid>" data="<qid>"）
 *   题号题型:     .mark_name .colorShallow   → "1. (单选题, 5.0 分)"
 *   题干:         .mark_name .qtContent      → 常为 <img>
 *   选项:         .mark_letter li[role="option"]  → "A. xxx"
 *   我的答案:     .stuAnswerContent
 *   正确答案:     .rightAnswerContent        （仅回顾态存在）
 *   得分:         .mark_score
 *
 * 重要：题干文字使用自定义字体映射加密，DOM 文本形如 "寙寑寗线" 乱码，
 *      因此提取时必须同时给出图片 URL，实际作答走视觉路径。
 */
(function () {
  "use strict";

  // 防重复注入
  if (window.CXModel) return;
  const SITE = {
    CHAOXING: "chaoxing",
    UNKNOWN: "unknown",
  };

  function detectSite() {
    const h = location.hostname;
    if (/(^|\.)chaoxing\.com$/.test(h) || /(^|\.)xuexitong\.com$/.test(h)) return SITE.CHAOXING;
    return SITE.UNKNOWN;
  }

  /** 页面类型判定 */
  function detectPageType() {
    const p = location.pathname;
    const s = location.search;

    if (/\/ananas\/modules\/video\//.test(p)) return "video";
    if (/\/mycourse\/studentstudy/.test(p)) return "study";
    if (/\/mooc2\/work\/dowork/.test(p)) return "work";
    // 旧版作业 / 章节练习作答页
    if (/\/work\/doHomeWorkNew/.test(p)) return "work";
    if (/\/mooc2\/work\/list/.test(p)) return "work-list";
    // 查看/回顾页（只能看，不能改）——注意：`mooc2/exam/preview` **不是**预览页，
    // 它是 newMooc 的整卷作答页（URL 带 remainTimeParam / monitorStatus / relationAnswerLastUpdateTime）。
    if (/\/exam-ans\/[^?]*\/(look)(\/|$|\?)/.test(p)) return "exam-preview";
    if (/\/exam\/test\/look(\/|$|\?)/.test(p)) return "exam-preview";
    // 考前须知 / 考试重置页：只是说明页，点上没有题
    if (/\/examcode\/examnotes/.test(p)) return "exam-preview";
    // 考试作答页（一屏一题，p=页码）
    if (/reVersionPaperMarkContentNew/.test(p)) return "exam";
    if (/reVersionTestStartNew/.test(p)) return "exam";
    if (/\/exam-ans\/mooc2\/exam\/(preview|test|doexam)/.test(p)) return "exam";
    if (/\/exam-ans\/exam\/test\//.test(p)) return "exam";
    if (/\/mooc-ans\/knowledge\/cards/.test(p)) return "cards";
    return "other";
  }

  /** URL 参数 */
  function parseParams() {
    const q = new URLSearchParams(location.search);
    const pick = (...keys) => {
      for (const k of keys) {
        const v = q.get(k);
        if (v) return v;
      }
      return null;
    };
    return {
      courseId: pick("courseId", "courseid"),
      clazzId: pick("clazzId", "clazzid", "classId"),
      cpi: pick("cpi"),
      chapterId: pick("chapterId", "knowledgeid", "knowledgeId"),
      workId: pick("workId", "workid"),
      examId: pick("examId"),
      answerId: pick("answerId"),
      enc: pick("enc"),
      openc: pick("openc"),
    };
  }

  /** 清理文本：去多余空白、去零宽字符 */
  function clean(v) {
    return String(v == null ? "" : v)
      .replace(/[\u200b-\u200f\ufeff]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  /** 从题号行解析题型与分值，如 "1. (单选题, 5.0 分)" / "1.（单选题，5.0 分）" */
  function parseTitle(raw) {
    const t = clean(raw);
    // 学习通页面全角/半角括号混用，两种都要吃
    const m = t.match(/[（(]\s*([^,，)）]+?)\s*[,，]\s*([\d.]+)\s*分\s*[)）]/);
    let type = "unknown";
    let score = null;
    if (m) {
      const zh = m[1];
      score = parseFloat(m[2]);
      if (/单选/.test(zh)) type = "single";
      else if (/多选/.test(zh)) type = "multiple";
      else if (/判断/.test(zh)) type = "judge";
      else if (/填空/.test(zh)) type = "fill";
      else if (/简答|问答|论述/.test(zh)) type = "short";
      else if (/计算/.test(zh)) type = "calc";
      else type = zh;
    }
    const numMatch = t.match(/^\s*(\d+)\s*[.．、]/);
    return {
      index: numMatch ? parseInt(numMatch[1], 10) : null,
      type,
      score,
      raw: t,
    };
  }

  /** 题干：优先文本，其次图片 */
  function readStem(li) {
    const holder = li.querySelector(".mark_name");
    if (!holder) return { text: "", images: [], html: "" };

    // 克隆后剔除题型/题号，只留题干
    const clone = holder.cloneNode(true);
    clone.querySelectorAll(".colorShallow").forEach((n) => n.remove());
    const images = [];
    clone.querySelectorAll("img").forEach((img) => {
      let src = img.getAttribute("data-original") || img.src || "";
      src = src.replace("375_1024", "origin").replace("750_1024", "origin");
      if (src) images.push(src);
    });
    // 文本部分（可能被字体加密 / 公式是图片，仅作参考）
    const text = clean(clone.textContent);

    return { text, images, html: clone.innerHTML || "" };
  }

  /**
   * 选项：双结构兼容
   *   新版考试/整卷预览（exam-ans）：.answerBg > .num_option + .answer_p
   *   旧版作业/回顾页：          .mark_letter li[role="option"]
   *
   * ⚠️ 新版考试页的选项是**打乱渲染**的：
   *     .num_option 的 data 属性 = 原始编号（A/B/C/D 乱序）
   *     .num_option 的文本内容   = 屏幕上显示的编号（A→B→C→D 顺序）
   *   用户看到的是「显示编号」，所以 label 必须取文本，不能取 data。
   *   提交时页面自己读 data，我们只负责点对那个元素。
   */
  function readOptions(li) {
    // --- 新版：.answerBg ---
    const bg = li.querySelectorAll(".answerBg");
    if (bg.length) {
      return [...bg].map((n, i) => {
        const labelEl = n.querySelector(".num_option");
        const textEl = n.querySelector(".answer_p");
        const displayLabel = clean(labelEl ? labelEl.textContent : "");
        const originalLabel = (labelEl && labelEl.getAttribute("data")) || "";
        return {
          index: i,
          // 以显示编号为准（用户与 AI 看到的是这个）
          label: (function () {
            let L = String(displayLabel || "").replace(/[^A-Za-z]/g, "").toUpperCase();
            if (!L) L = String(originalLabel || "").replace(/[^A-Za-z]/g, "").toUpperCase();
            if (!L) L = String.fromCharCode(65 + i);
            return L;
          })(),
          originalLabel: String(originalLabel).toUpperCase(),
          text: clean(textEl ? textEl.textContent : ""),
          raw: clean(n.textContent),
          node: n,
        };
      });
    }

    // --- 旧版：.mark_letter li[role="option"] ---
    const nodes = li.querySelectorAll('.mark_letter li[role="option"]');
    const out = [];
    nodes.forEach((n, i) => {
      const raw = clean(n.textContent);
      const m = raw.match(/^([A-Za-z])\s*[.．、)]\s*(.*)$/);
      out.push({
        index: i,
        label: m ? m[1].toUpperCase() : String.fromCharCode(65 + i),
        originalLabel: m ? m[1].toUpperCase() : "",
        text: m ? clean(m[2]) : raw,
        raw,
        node: n,
      });
    });
    if (out.length) return out;

    // --- 兜底：考试作答页（exam-ans）结构不固定，按"可点选项"特征抓 ---
    // 只在题目容器内匹配；答题卡（题号导航）必须排除，否则点选项会变成"跳到第 N 题"。
    const CARD_SELECTOR =
      '#answerSheet, #answerSheetH, .answerSheet, .answerSheetBox, .Marking_right_280, ' +
      '.markingRight_paper, .topicNumber_list, ul.topicNumber_list, .legendBox, ' +
      '.phone_main_title, h4.cardTit, li[data-asq], li[id^="answerSheet"], li.nav-revise';
    const isCard = (n) => {
      try { return !!n.closest(CARD_SELECTOR); } catch (_) { return true; }
    };
    const generic = li.querySelectorAll(
      '#randomOptions li, .randomOptions li, ul li[role="option"], ul li[role="radio"], ' +
      'ul li[role="checkbox"], li[onclick*="addChoice"], li[onclick*="choose"], ' +
      '.stem_answer li, .answerList li'
    );
    generic.forEach((n, i) => {
      if (isCard(n)) return;
      if (n.querySelector('li')) return; // 只取叶子项
      const numEl = n.querySelector(".num_option, .option_num, i");
      const shown = clean(numEl ? numEl.textContent : "");
      const dataLabel = numEl ? (numEl.getAttribute("data") || "") : "";
      let label = (dataLabel || shown || "").replace(/[^A-Za-z]/g, "").toUpperCase();
      if (label.length > 1) label = label[0];
      if (!label) label = String.fromCharCode(65 + i);
      const textNode = n.querySelector(".after, .answer_p, span:not(.num_option)");
      out.push({
        index: i,
        label,
        originalLabel: label,
        text: clean(textNode ? textNode.textContent : n.textContent),
        raw: clean(n.textContent),
        node: n,
      });
    });
    return out;
  }

  /** 该节点是否属于答题卡（题号导航）——点击它等于跳题，绝不能在填答案时点 */
  function isAnswerSheetNode(node) {
    if (!node || !node.closest) return false;
    try {
      return !!node.closest(
        '#answerSheet, #answerSheetH, .answerSheet, .answerSheetBox, .Marking_right_280, ' +
        '.markingRight_paper, .topicNumber_list, ul.topicNumber_list, .legendBox, ' +
        '.phone_main_title, h4.cardTit, li[data-asq], li[id^="answerSheet"], li.nav-revise'
      );
    } catch (_) {
      return true;
    }
  }

  /** 已有答案（回顾态 / 新版隐藏 input） */
  function readAnswers(li) {
    // 新版：答案存在隐藏 input
    const hidden = li.querySelector('input[id^="answer"], input[name^="answer"]');
    if (hidden) {
      return {
        mine: clean(hidden.value),
        right: "",
        score: "",
        judge: "",
        hasWrongMark: !!li.querySelector(".marking_cuo"),
        hasRightMark: !!li.querySelector(".marking_dui"),
      };
    }
    return {
      mine: clean(li.querySelector(".stuAnswerContent")?.textContent),
      right: clean(li.querySelector(".rightAnswerContent")?.textContent),
      score: clean(li.querySelector(".mark_score")?.textContent),
      judge: clean(li.querySelector(".mark_judge_name")?.textContent),
      hasWrongMark: !!li.querySelector(".marking_cuo"),
      hasRightMark: !!li.querySelector(".marking_dui"),
    };
  }

  /** 题目唯一 id */
  function readQuestionId(li) {
    return (
      li.getAttribute("questionId") ||
      li.getAttribute("data") ||
      (li.id || "").replace(/^question/, "") ||
      ""
    );
  }

  /** 读取单道题（`.questionLi` 节点 → 结构化题目） */
  function readQuestion(li, i, doc) {
    const markName = li.querySelector(".mark_name");
    const rawTitle = clean(markName ? markName.textContent : "");
    const titleInfo = parseTitle(rawTitle);
    // 题号常在题干 div 里，被 "(单选题, 5.0 分)" 挤到前面，单独再抠一次
    if (titleInfo.index == null && markName) {
      try {
        const clone = markName.cloneNode(true);
        clone.querySelectorAll(".colorShallow").forEach((n) => n.remove());
        const m = clean(clone.textContent).match(/^\s*(\d+)\s*[.．、)）]/);
        if (m) titleInfo.index = parseInt(m[1], 10);
      } catch (_) {}
    }
    return {
      seq: i,
      qid: readQuestionId(li),
      index: titleInfo.index,
      type: titleInfo.type,
      score: titleInfo.score,
      titleRaw: titleInfo.raw,
      stem: readStem(li),
      options: readOptions(li),
      answers: readAnswers(li),
      node: li,
      doc: doc || (li.ownerDocument || document),
    };
  }

  /** 从容器提取全部题目（仅当前文档） */
  function extractQuestions(root) {
    const scope = root || document;
    const list = scope.querySelectorAll(".questionLi");
    const out = [];
    list.forEach((li, i) => out.push(readQuestion(li, i, scope.ownerDocument || document)));
    return out;
  }

  /**
   * 跨同域 iframe 提取题目。
   * 学习页的题在 studentstudy → #iframe(knowledge/cards) → ananas/modules/work 里，
   * 顶层 document 一条都取不到，所以自动答题必须走这个版本。
   */
  function extractQuestionsDeep(root) {
    const out = [];
    const seen = new Set();
    const walk = (doc, depth) => {
      if (!doc || depth > 6 || out.length > 400) return;
      let list = [];
      try { list = [...doc.querySelectorAll(".questionLi")]; } catch (_) {}
      for (const li of list) {
        if (seen.has(li)) continue;
        seen.add(li);
        out.push(readQuestion(li, out.length, doc));
      }
      let frames = [];
      try { frames = [...doc.querySelectorAll("iframe")]; } catch (_) {}
      for (const fr of frames) {
        let d = null;
        try { d = fr.contentDocument; } catch (_) {}
        if (d && d.body) walk(d, depth + 1);
      }
    };
    walk((root && (root.ownerDocument || root)) || document, 0);
    return out;
  }

  /** 元素在**顶层窗口**中的绝对矩形（跨 iframe 截图必须用它） */
  function absoluteRect(node) {
    const r = node.getBoundingClientRect();
    let x = r.x, y = r.y;
    let doc = node.ownerDocument || document;
    let win = doc.defaultView;
    let guard = 0;
    while (win && win !== window && guard++ < 8) {
      let fe = null;
      try { fe = win.frameElement; } catch (_) {}
      if (!fe) break;
      const fr = fe.getBoundingClientRect();
      x += fr.x;
      y += fr.y;
      doc = fe.ownerDocument;
      win = doc.defaultView;
    }
    return { x, y, width: r.width, height: r.height };
  }

  /** 摘要（供 UI 展示，避免把 DOM 节点传出） */
  function summarize(questions) {
    return questions.map((q) => ({
      seq: q.seq,
      qid: q.qid,
      index: q.index,
      type: q.type,
      score: q.score,
      stemText: q.stem.text.slice(0, 80),
      hasImage: q.stem.images.length > 0,
      optionCount: q.options.length,
      options: q.options.map((o) => o.label + ". " + o.text.slice(0, 30)),
      answered: !!q.answers.mine,
      rightAnswer: q.answers.right || null,
    }));
  }

  /** 学习页左侧/顶部任务点 tab（1内容/2练习/3案例/4拓展） */
  function readTaskTabs() {
    const ul = document.querySelector("ul.prev_ul, .prev_ul");
    if (!ul) return [];
    return [...ul.querySelectorAll("li")]
      .map((li, i) => {
        const oc = li.getAttribute("onclick") || "";
        const m = oc.match(/changeDisplayContent\(\s*(\d+)\s*,\s*(\d+)/);
        return {
          index: m ? parseInt(m[1], 10) : i + 1,
          total: m ? parseInt(m[2], 10) : null,
          text: clean(li.textContent),
          onclick: oc,
          node: li,
        };
      })
      .filter((t) => t.onclick.includes("changeDisplayContent"));
  }

  /** 章节目录节点 */
  function readCatalogNodes() {
    return [...document.querySelectorAll(".posCatalog_name, .posCatalog_select")].map((n) => ({
      text: clean(n.textContent),
      onclick: n.getAttribute("onclick") || "",
      className: n.className,
      node: n,
    }));
  }

  const api = {
    SITE,
    detectSite,
    detectPageType,
    parseParams,
    clean,
    parseTitle,
    readStem,
    readOptions,
    isAnswerSheetNode,
    readAnswers,
    extractQuestions,
    extractQuestionsDeep,
    absoluteRect,
    readQuestion,
    summarize,
    readTaskTabs,
    readCatalogNodes,
  };

  window.CXModel = api;
})();
