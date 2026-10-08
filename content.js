// Content Script - 题目识别和自动答题

(function () {
  "use strict";
  if(window.__AIAnswerContentLoaded)return;
  window.__AIAnswerContentLoaded=true;

  // State
  let questions = [];
  let answeredCount = 0;
  let isRunning = false;
  let config = null;
  let autoContinue = false;
  let skipUnfinished=false;
  let skippedPages=[];
  let lastAdvanceStatus="failed";
  let pageTouched = false;
  let lastActionAt = 0;
  let cancelRequested = false;
  let aiAuthFailed = false;
  let scanSerial = 0;
  let submittedGroups = 0;

  // Question selectors for common exam platforms
  const QUESTION_SELECTORS = [
    // 通用选择器
    ".question",
    ".question-item",
    ".exam-question",
    ".test-question",
    ".quiz-question",
    '[class*="question"]',
    '[class*="Question"]',
    // 题目容器
    ".problem",
    ".problem-item",
    ".exercise",
    ".exercise-item",
    // 表单题目
    "form .item",
    "form .form-item",
    // 列表题目
    ".question-list > li",
    ".question-list > div",
    "ol.questions > li",
    "ul.questions > li",
  ];

  // Option selectors
  const OPTION_SELECTORS = [
    'input[type="radio"]',
    'input[type="checkbox"]',
    ".option",
    ".choice",
    ".answer-option",
    '[class*="option"]',
    '[class*="choice"]',
    "label",
  ];

  // Fill-in-the-blank selectors
  const FILL_SELECTORS = [
    'input[type="text"]',
    "input:not([type])",
    "textarea",
    ".blank",
    ".fill-blank",
    '[class*="blank"]',
    '[contenteditable="true"]',
  ];

  // AI分析得到的选择器缓存
  let aiDetectedSelectors = null;

  // Message listener
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if(location.hostname==='welearn.sflep.com')return false;
    if(message.action==='welearnAdvanceEmbedded'){
      window.welearnAPI.advanceEmbedded({cancelled:()=>cancelRequested}).then(sendResponse).catch(e=>sendResponse({status:'failed',reason:e.message}));
      return true;
    }
    if(message.action==='welearnProcess'){
      processWelearn(message).then(sendResponse).catch(e=>sendResponse({status:'scan_failed',reason:e.message,count:0,answered:0}));
      return true;
    }
    if(message.action==='welearnStop'){scanSerial++;stopAnswering();sendResponse({success:true});return false;}
    switch (message.action) {
      case "scan":
        config = message.config;
        cancelRequested = false;
        handleScan(sendResponse);
        return true; // 保持消息通道开放用于异步响应
      case "start":
        config = message.config;
        skipUnfinished=!!message.skipUnfinished; skippedPages=[];
        autoContinue = (!!message.autoContinue||skipUnfinished) && window.location.hostname === "ucontent.unipus.cn";
        pageTouched = false;
        cancelRequested = false;
        aiAuthFailed = false;
        // 始终重新扫描（SPA 页面可能已跳转）
        questions = [];
        answeredCount = 0;
        aiDetectedSelectors = null;
        handleScan((scanResult) => {
          if (cancelRequested || scanResult?.cancelled) return;
          if ((scanResult && scanResult.success) || (autoContinue && (isPassiveCoursePage() || isSkippableCommentPage())) || (skipUnfinished && !scanResult?.authError)) {
            startAnswering();
          } else {
            if (!scanResult?.authError) sendLog("warning", scanResult?.message || "扫描未发现题目");
            sendComplete(false);
          }
        });
        sendResponse({ success: true });
        break;
      case "stop":
        stopAnswering();
        sendResponse({ success: true });
        break;
      case "getStatus":
        sendResponse({
          ...window.CourseAnswerTools.stats(questions, submittedGroups),
          isRunning,
        });
        break;
    }
    return true;
  });


  async function processWelearn(message) {
    const operation=++scanSerial;
    config=message.config;cancelRequested=false;isRunning=true;
    let touched=false,done=0,fatal=null;
    const actual=decodeURIComponent(location.search).match(/m-\d+-\d+-(?:\d+|intro)(?![\d])/i)?.[0];
    if(message.sco&&actual&&message.sco!==actual){isRunning=false;return {status:'scan_failed',reason:'目标课件与实际页面不一致',count:0,answered:0};}
    if(message.resetNavigation)window.welearnAPI.resetEmbedded?.();
    const page=window.welearnAPI.inspectPage();
    if(page.status!=='ready'){isRunning=false;return {status:page.status,reason:page.reason,count:0,answered:0};}
    questions=page.questions;answeredCount=0;
    if(location.hash){
      try{const raw=await window.welearnAPI.getAnswers();
        if(raw?.answers?.length===questions.length)raw.answers.forEach((a,i)=>{if(a.answers?.length)questions[i].answer=questions[i].type==='multiple'?a.answers:a.answers[0];});
      }catch(e){sendLog('warning','新版课件数据读取未成功，将按题目上下文处理');}
    }
    try {
      for(const q of questions){
        if(cancelRequested)break;
        if(q.answer!=null)q._welearnAnswer=true;
        else if(document.querySelector('audio,video')&&/listen|watch|podcast/i.test((q.direction||q.text)+' '+q.context.slice(0,2500))&&!q.transcript){
          sendLog('warning','音视频题缺少原文和页面答案，保留为未完成');continue;
        }
        if(q.transcript)q.context+='\n音视频原文：'+q.transcript;
        try{
          const response=await getAnswerWithBackoff(q);
          if(cancelRequested||operation!==scanSerial)break;
          if(response?.answer!=null){
            const ok=await window.welearnAPI.apply(q,response.answer);
            touched=touched||!!q._touched;
            if(ok){q.answered=true;done++;answeredCount=done;updateStats();}
            else sendLog('warning','WE Learn 答案写入未通过核验');
          }
        }catch(e){
          if(isAiAuthError(e)){fatal='auth';break;}
          if(isRateLimitText(e.message)){fatal='rate_limit';break;}
          sendLog('warning','本题处理失败：'+e.message);
        }
      }
      if(cancelRequested||operation!==scanSerial)return {status:'cancelled',count:questions.length,answered:done,reason:'用户已停止'};
      let submitted=false;
      if(touched){
        if(await paceAction('WE Learn 提交'))submitted=await window.welearnAPI.clickSubmit({allowPartial:done!==questions.length||page.unsupported,cancelled:()=>cancelRequested||operation!==scanSerial});
        if(!submitted)sendLog('warning','已填写内容尚未取得提交成功确认，未标记整页完成');
      }
      return {...window.CourseAnswerTools.stats(questions, submitted?done:0),count:questions.length,answered:done,status:fatal||(submitted&&done===questions.length&&!page.unsupported?'completed':touched?'submit_failed':'answer_failed'),
        reason:fatal?'AI 配置或请求限流需检查':submitted&&done===questions.length&&!page.unsupported?'当前页填写与提交已确认':'仍有未完成题目或提交尚未确认'};
    }finally{if(operation===scanSerial)isRunning=false;}
  }

  // 从 WeLearn 解析结果创建题目对象
  function createWelearnQuestions(answers) {
    const typeMap = {
      single: "single",
      blank_choice: "fill",
      fill: "fill",
      tof: "single",
    };

    const qs = [];
    let tabName = "";

    answers.forEach((a, i) => {
      if (a.tabName && a.tabName !== tabName) {
        tabName = a.tabName;
      }

      const qtype = typeMap[a.type] || "single";
      const q = {
        index: i,
        type: qtype,
        text: (tabName ? "[" + tabName + "] " : "") + (a.questionText || ""),
        options: [],
        inputs: [],
        answered: false,
        answer: a.answers[0],
        _welearnAnswer: true,
      };

      // 为选择题带上选项文本（从数据 HTML 中提取的答案即选项内容）
      if (qtype === "single" && a.answers[0]) {
        q.options = [{
          label: a.answers[0],
          text: a.answers[0],
        }];
      }

      qs.push(q);
    });

    return qs;
  }

  // One API child represents one answer position; alternatives stay in that position.
  function mergeApiAnswers(questions, apiAnswers) {
    const result = window.CourseAnswerTools.bind(questions, apiAnswers);
    if (!result.ok) sendLog('warning', result.reason);
    return result;
  }

  async function showSequenceAnswers(sequence, isStale) {
    if (!sequence?.items.length || isStale()) return;
    let raw = null, source = '网页答案', note = '请按以下对应关系手动排列；展示答案不计为已提交';
    try {
      const info = window.unipusAPI?.extractPageInfo();
      if (info?.courseInstanceId && info.taskId && await paceAction('读取配对参考答案')) {
        const rows = await window.unipusAPI.getAnswersForTask(info.courseInstanceId, info.taskId, info.openId);
        if (isStale()) return;
        if (rows?.length === 1) raw = rows[0].answers;
        else if (rows?.length === sequence.slots.length && rows.every(r => r.answers?.length === 1)) raw = rows.map(r=>r.answers[0]);
      }
    } catch (e) { sendLog('warning', '配对答案读取未成功：' + e.message); }
    let rows = window.CourseAnswerTools.sequence(sequence, raw);
    if (!rows && !isStale()) {
      if (sequence.items.some(o=>o.images?.length && !o.text && !o.images.every(img=>img.alt))) {
        sendLog('warning', '图片选项缺少文字说明，当前文本模型缺少判断依据；等待网页答案或图片识别');
        return;
      }
      const q = {type:'sequence',text:sequence.slots.map((v,i)=>(i+1)+'. '+v.text).join('\n'),
        direction:'按题号顺序返回选项字母数组，每个字母只能使用一次。',inputs:[],
        options:sequence.items.map(o=>({label:o.label,text:o.text||o.images.map(x=>x.alt).join(' ')})),
        context:document.querySelector('.abs-direction')?.textContent || ''};
      let result;
      try { result = await getAnswerWithBackoff(q); }
      catch (e) { if(isAiAuthError(e))aiAuthFailed=true;sendLog('warning','参考答案请求未成功：'+e.message);return; }
      if (isStale()) return;
      rows = window.CourseAnswerTools.sequence(sequence, result?.answer);
      source = 'AI参考答案';
      note = '依据当前文字材料生成，请核对后手动排列；展示不计为已提交';
    }
    if (rows) chrome.runtime.sendMessage({type:'answerPreview',source,rows,note,page:getCoursePageMarker()});
    else sendLog('warning','本页参考答案尚未取得或排列格式未通过校验');
  }

  // 处理扫描请求
  async function handleScan(sendResponse) {
    const scanId = ++scanSerial;
    submittedGroups = 0;
    const scanMarker = getCoursePageMarker();
    const isStale = () => cancelRequested || scanId !== scanSerial || scanMarker !== getCoursePageMarker();
    if (window.location.hostname === 'ucontent.unipus.cn' &&
        (isPassiveCoursePage() || isSkippableCommentPage())) {
      const reviewRows = window.UnipusPageModel?.reviewAnswers?.() || [];
      if (reviewRows.length) chrome.runtime.sendMessage({type:'answerPreview',source:'网页已显示的解析',rows:reviewRows,note:'按网页空位编号提取',page:getCoursePageMarker()});
      questions = [];
      answeredCount = 0;
      updateStats();
      sendLog('info', window.UnipusPageModel?.inspect().reason || '当前为视频/阅读/评论页，没有可答题目，跳过 AI 分析');
      sendResponse({ success: true, count: 0, passive: true });
      return;
    }
    if (!config) {
      sendResponse({ success: false, count: 0, message: "请先配置API" });
      return;
    }

    // 步骤1: 尝试匹配站点模板
    sendLog("info", "正在匹配站点模板...");
    // 确保模板已初始化（避免竞态）
    if (window.templateManager && !window.templateManager._initialized) {
      await window.templateManager.init();
      window.templateManager._initialized = true;
    }
    const template = window.siteMatcher.matchTemplate(window.location.href);
    if (isStale()) { sendResponse({success:false, cancelled:true}); return; }

    if (template) {
      sendLog("info", `已匹配到站点模板: ${template.siteName}`);

      // WeLearn 分层策略：从数据 HTML 直取正解
      if (template.siteId === "welearn" && window.welearnAPI) {
        sendLog("info", "检测到 WE Learn 页面，从数据 HTML 获取正解...");
        try {
          const wlResult = await window.welearnAPI.getAnswers();
          if (wlResult && wlResult.answers && wlResult.answers.length > 0) {
            questions = createWelearnQuestions(wlResult.answers);
            answeredCount = 0;
            updateStats();
            // iframe 内自动点击正确答案并提交
            if (window.welearnAPI.isInIframe()) {
              const fillResult = window.welearnAPI.autoFillAnswers(wlResult.answers);
              sendLog("success", `已自动填入 ${fillResult.clicked}/${fillResult.total} 题`);
              setTimeout(() => window.welearnAPI.clickSubmit(), 800);
            }
            await window.templateManager.updateStats(template.siteId, "success");
            sendLog("success", `从数据 HTML 获取到 ${wlResult.answers.length} 个答案`);
            sendResponse({ success: true, count: questions.length, message: "" });
            return;
          } else {
            sendLog("warning", "WE Learn 数据 HTML 未解析到答案，回退到 AI 模式");
          }
        } catch (e) {
          sendLog("warning", `WE Learn 解析失败: ${e.message}，回退到 AI 模式`);
          await window.templateManager.updateStats(template.siteId, "fail");
        }
      }

      try {
        // 使用模板扫描
        const scanner = new window.EnhancedScanner();
        const result = scanner.scanWithTemplate(template);

        if (result.status && result.status !== 'ready') {
          questions = [];
          answeredCount = 0;
          updateStats();
          const passive = ['discussion', 'review', 'passive'].includes(result.status);
          sendLog(passive ? 'info' : 'warning', result.reason);
          if (result.sequence) await showSequenceAnswers(result.sequence, isStale);
          if (isStale()) { sendResponse({success:false,cancelled:true}); return; }
          sendResponse({ success: passive, count: 0, passive, authError:aiAuthFailed, message: result.reason });
          return;
        }

        if (result.success && result.count > 0) {
          // 模板扫描成功
          questions = result.questions;
          answeredCount = 0;

          // U校园分层策略：从 API 直取服务端正解
          if (template.siteId === "unipus" && window.unipusAPI) {
            sendLog("info", "检测到 U校园页面，尝试获取服务端正解...");
            const pageInfo = window.unipusAPI.extractPageInfo();
            if (
              pageInfo &&
              pageInfo.courseInstanceId &&
              pageInfo.taskId
            ) {
              const apiAnswers = await paceAction('平台答案')
                ? await window.unipusAPI.getAnswersForTask(
                    pageInfo.courseInstanceId,
                    pageInfo.taskId,
                    pageInfo.openId
                  ) : [];
              if (isStale()) { sendResponse({success:false, cancelled:true}); return; }
              if (apiAnswers && apiAnswers.length > 0) {
                const merged = mergeApiAnswers(questions, apiAnswers);
                if (merged.ok) sendLog(
                  "success",
                  `从 U校园 API 获取到 ${apiAnswers.length} 个作答位的答案（备选写法保留在同一空位）`
                );
              } else {
                sendLog(
                  "warning",
                  "U校园 API 未返回答案，回退到 AI 模式"
                );
              }
            } else {
              sendLog(
                "warning",
                `未能提取页面信息 (courseInstanceId:${pageInfo?.courseInstanceId}, taskId:${pageInfo?.taskId})，回退到 AI 模式`
              );
            }
          }

          // 过滤聚合容器（选项数 > 10）并更新面板
          const before = questions.length;
          questions = questions.filter(q => template.siteId === 'unipus' || !q.options || q.options.length <= 10);
          if (before !== questions.length) {
            sendLog("info", `已过滤 ${before - questions.length} 个聚合容器`);
          }

          updateStats();

          sendLog("success", `使用模板扫描成功，有效题目 ${questions.length} 道`);

          // 更新模板统计
          await window.templateManager.updateStats(template.siteId, "success");

          sendResponse({ success: true, count: questions.length, message: "" });
          return;
        } else {
          // 模板扫描失败，回退到AI分析
          sendLog("warning", `模板扫描失败，回退到AI分析...`);
          await window.templateManager.updateStats(template.siteId, "fail");
        }
      } catch (error) {
        if (isStale()) { sendResponse({success:false, cancelled:true}); return; }
        sendLog("error", `模板扫描出错: ${error.message}，回退到AI分析`);
        await window.templateManager.updateStats(template.siteId, "fail");
      }
    } else {
      sendLog("info", "未找到匹配的站点模板，使用AI分析...");
    }

    // 步骤2: 使用AI分析（无模板或模板失败时）
    if (aiAuthFailed) {
      sendResponse({ success: false, count: 0, authError: true,
        message: '当前 AI 配置收到 401，请在设置中测试实际启用的配置' });
      return;
    }
    sendLog("info", "正在使用AI分析页面结构，请耐心等待...");

    try {
      const aiResult = await analyzePageWithAI();
      if (isStale()) { sendResponse({success:false, cancelled:true}); return; }
      if (aiResult && aiResult.success) {
        aiDetectedSelectors = aiResult.selectors;
        const count = scanWithAISelectors(aiResult);
        if (count > 0) {
          sendLog("success", `AI分析成功，发现 ${count} 道题目`);
          sendResponse({ success: true, count, message: "" });
        } else {
          sendLog("warning", "AI分析完成，但未能定位到题目元素");
          sendResponse({
            success: false,
            count: 0,
            message: "未能定位到题目元素",
          });
        }
      } else {
        sendLog("warning", "AI分析未发现题目");
        sendResponse({ success: false, count: 0, message: "未发现题目" });
      }
    } catch (error) {
      if (isStale()) { sendResponse({success:false, cancelled:true}); return; }
      if (isAiAuthError(error)) {
        aiAuthFailed = true;
        const message = '当前 AI 请求收到 401；请打开设置，检查实际启用的配置并点击“测试当前配置”。这不代表页面答案识别失败，也不直接证明密钥过期。';
        sendLog('error', message);
        sendResponse({ success: false, count: 0, authError: true, message });
      } else {
        sendLog("error", `AI分析失败: ${error.message}`);
        sendResponse({ success: false, count: 0, message: error.message });
      }
    }
  }

  // Scan for questions on the page
  function scanQuestions() {
    questions = [];
    answeredCount = 0;

    // Try each selector
    for (const selector of QUESTION_SELECTORS) {
      try {
        const elements = document.querySelectorAll(selector);
        if (elements.length > 0) {
          elements.forEach((el, index) => {
            const question = parseQuestion(el, index);
            if (question) {
              questions.push(question);
            }
          });
          if (questions.length > 0) break;
        }
      } catch (e) {
        console.log("Selector error:", selector, e);
      }
    }

    // If no questions found with selectors, try heuristic detection
    if (questions.length === 0) {
      questions = detectQuestionsHeuristically();
    }

    // Remove duplicates
    questions = removeDuplicates(questions);

    sendLog("info", `扫描完成，发现 ${questions.length} 道题目`);
    updateStats();

    return questions.length;
  }

  // Parse a question element
  function parseQuestion(element, index) {
    const question = {
      index,
      element,
      type: null,
      text: "",
      options: [],
      inputs: [],
      answered: false,
    };

    // Get question text
    const textElements = element.querySelectorAll(
      "p, span, div, h1, h2, h3, h4, h5, h6"
    );
    let questionText = "";

    // Try to find the main question text
    const titleEl = element.querySelector(
      '.title, .question-title, .question-text, .stem, [class*="title"], [class*="stem"]'
    );
    if (titleEl) {
      questionText = titleEl.textContent.trim();
    } else {
      // Get first meaningful text
      for (const el of textElements) {
        const text = el.textContent.trim();
        if (text.length > 10 && !text.match(/^[A-D][\.\、\s]/)) {
          questionText = text;
          break;
        }
      }
    }

    if (!questionText) {
      questionText = element.textContent.trim().substring(0, 500);
    }

    question.text = cleanText(questionText);

    // Detect question type and get options/inputs
    const radios = element.querySelectorAll('input[type="radio"]');
    const checkboxes = element.querySelectorAll('input[type="checkbox"]');
    const textInputs = element.querySelectorAll(
      'input[type="text"], input:not([type]), textarea'
    );

    if (radios.length > 0) {
      question.type = "single";
      question.options = parseOptions(element, radios);
    } else if (checkboxes.length > 0) {
      question.type = "multiple";
      question.options = parseOptions(element, checkboxes);
    } else if (textInputs.length > 0) {
      question.type = "fill";
      question.inputs = Array.from(textInputs);
    } else {
      // Try to detect from text
      if (
        question.text.includes("多选") ||
        question.text.includes("多项选择")
      ) {
        question.type = "multiple";
      } else if (
        question.text.includes("单选") ||
        question.text.includes("单项选择")
      ) {
        question.type = "single";
      } else if (
        question.text.includes("填空") ||
        question.text.includes("____") ||
        question.text.includes("___")
      ) {
        question.type = "fill";
      }

      // Try to find clickable options
      const optionEls = element.querySelectorAll(
        '.option, .choice, [class*="option"], [class*="choice"], li'
      );
      if (optionEls.length >= 2 && optionEls.length <= 8) {
        question.type = question.type || "single";
        question.options = Array.from(optionEls).map((el, i) => ({
          element: el,
          label: String.fromCharCode(65 + i),
          text: el.textContent.trim(),
        }));
      }
    }

    // Skip if no valid type detected
    if (!question.type) {
      return null;
    }

    return question;
  }

  // Parse options from input elements
  function parseOptions(container, inputs) {
    const options = [];

    inputs.forEach((input, index) => {
      const label =
        input.closest("label") ||
        container.querySelector(`label[for="${input.id}"]`) ||
        input.parentElement;

      let optionText = "";
      let optionLabel = String.fromCharCode(65 + index);

      if (label) {
        optionText = label.textContent.trim();
        // Extract label letter if present
        const match = optionText.match(/^([A-Z])[\.\、\s]/);
        if (match) {
          optionLabel = match[1];
          optionText = optionText.substring(match[0].length).trim();
        }
      }

      options.push({
        element: input,
        label: optionLabel,
        text: optionText,
      });
    });

    return options;
  }

  // Heuristic question detection
  function detectQuestionsHeuristically() {
    const detected = [];
    const allElements = document.body.querySelectorAll("*");

    // Look for numbered items that might be questions
    const numberPattern = /^[\d一二三四五六七八九十]+[\.\、\s]/;

    allElements.forEach((el, index) => {
      const text = el.textContent.trim();
      if (text.length > 20 && text.length < 2000 && numberPattern.test(text)) {
        // Check if it has options or inputs
        const hasOptions =
          el.querySelectorAll('input[type="radio"], input[type="checkbox"]')
            .length > 0;
        const hasInputs =
          el.querySelectorAll('input[type="text"], textarea').length > 0;

        if (hasOptions || hasInputs) {
          const question = parseQuestion(el, detected.length);
          if (question) {
            detected.push(question);
          }
        }
      }
    });

    return detected;
  }

  // 统一的DOM精简逻辑，去掉无关属性
  function simplifyElementAttributes(el) {
    const keepAttrs = [
      "class",
      "id",
      "type",
      "name",
      "value",
      "placeholder",
      "for",
      "data-index",
      "data-id",
    ];
    const attrs = Array.from(el.attributes || []);
    attrs.forEach((attr) => {
      if (!keepAttrs.includes(attr.name) && !attr.name.startsWith("data-")) {
        el.removeAttribute(attr.name);
      }
    });
    Array.from(el.children).forEach((child) =>
      simplifyElementAttributes(child)
    );
  }

  // 获取简化的页面HTML用于AI分析（作为候选块不足时的兜底）
  function getSimplifiedHTML() {
    const clone = document.body.cloneNode(true);
    const removeSelectors = [
      "script",
      "style",
      "noscript",
      "iframe",
      "svg",
      "img",
      "video",
      "audio",
      "canvas",
    ];
    removeSelectors.forEach((sel) => {
      clone.querySelectorAll(sel).forEach((el) => el.remove());
    });

    simplifyElementAttributes(clone);

    let html = clone.innerHTML;
    html = html.replace(/\s+/g, " ").replace(/>\s+</g, "><");

    if (html.length > 15000) {
      const mainSelectors = [
        "main",
        "article",
        ".content",
        ".main",
        "#content",
        "#main",
        ".container",
        ".wrapper",
      ];
      for (const sel of mainSelectors) {
        const main = clone.querySelector(sel);
        if (main && main.innerHTML.length > 500) {
          html = main.innerHTML.replace(/\s+/g, " ").replace(/>\s+</g, "><");
          break;
        }
      }
    }

    if (html.length > 15000) {
      html = html.substring(0, 30000) + "... [内容已截断]";
    }

    return html;
  }

  // 构建单个题目块的精简HTML字符串
  function buildSimplifiedBlockHTML(element, maxLength = 1500) {
    const clone = element.cloneNode(true);
    simplifyElementAttributes(clone);
    let html = clone.outerHTML || "";
    html = html.replace(/\s+/g, " ").replace(/>\s+</g, "><");
    if (html.length > maxLength) {
      html = html.substring(0, maxLength) + "... [片段截断]";
    }
    return html;
  }

  // 根据页面内容尝试提取候选题目块，显著减少发送给AI的数据量
  function getCandidateQuestionBlocks(maxBlocks = 20) {
    const candidateSet = new Set();

    function addCandidate(el) {
      if (!el || candidateSet.has(el)) return;
      candidateSet.add(el);
    }

    const optionInputs = document.querySelectorAll(
      'input[type="radio"], input[type="checkbox"]'
    );
    optionInputs.forEach((input) => {
      const container = findQuestionContainer(input.closest("label") || input);
      if (container) addCandidate(container);
    });

    const fillInputs = document.querySelectorAll(
      'input[type="text"], input[type="number"], textarea'
    );
    fillInputs.forEach((input) => {
      const container = findQuestionContainer(input.closest("label") || input);
      if (container) addCandidate(container);
    });

    if (candidateSet.size < 5) {
      const extraSelectors = [
        ".question",
        ".exam-question",
        ".topic",
        ".subject",
        ".problem",
      ];
      extraSelectors.forEach((sel) => {
        document.querySelectorAll(sel).forEach((el) => addCandidate(el));
      });
    }

    const candidates = Array.from(candidateSet).slice(0, maxBlocks);
    return candidates
      .map((el) => {
        const text = cleanText(el.textContent || "").substring(0, 200);
        return {
          text,
          html: buildSimplifiedBlockHTML(el),
        };
      })
      .filter((block) => block.text);
  }

  // 构建AI分析所需的内容，如果候选块为空则回退到整页HTML
  function buildAIAnalysisPayload() {
    const blocks = getCandidateQuestionBlocks();
    if (blocks.length > 0) {
      const formatted = blocks
        .map((block, index) => {
          return `【题目块${index + 1}】\n文本：${block.text}\nHTML：${
            block.html
          }`;
        })
        .join("\n\n");

      return {
        payload: `以下是筛选后的疑似题目区域（共${blocks.length}块）：\n${formatted}`,
        source: "candidateBlocks",
      };
    }

    return {
      payload: getSimplifiedHTML(),
      source: "fullHTML",
    };
  }

  // 使用AI分析页面结构（只识别题目，不返回答案）
  async function analyzePageWithAI() {
    const { payload, source } = buildAIAnalysisPayload();
    const contentIntro =
      source === "candidateBlocks"
        ? "本次提供的是经过前端筛选的疑似题目块，请基于这些块识别题目结构。"
        : "未找到足够的候选题目块，以下为整页精简HTML。";

    const prompt = `分析以下HTML页面，识别所有题目的结构。

【重要】只需要识别题目结构，不需要给出答案！

请返回JSON格式：
{
  "success": true,
  "questions": [
    {
      "index": 0,
      "type": "single",
      "text": "题目文本内容（完整的题干）",
      "options": [
        {
          "label": "A",
          "text": "选项内容",
          "selector": "精确的CSS选择器"
        }
      ]
    },
    {
      "index": 1,
      "type": "multiple",
      "text": "多选题文本",
      "options": [
        {
          "label": "A",
          "text": "选项内容",
          "selector": "CSS选择器"
        }
      ]
    },
    {
      "index": 2,
      "type": "fill",
      "text": "填空题文本",
      "inputs": [
        { "selector": "第1个输入框的CSS选择器" },
        { "selector": "第2个输入框的CSS选择器" }
      ]
    }
  ]
}

重要说明：
1. type: "single"单选题, "multiple"多选题, "fill"填空题
2. text: 必须包含完整的题干内容，后续需要用这个文本去获取答案
3. selector: 必须是可以直接用document.querySelector()定位到的精确CSS选择器
   - 优先使用id选择器: #elementId
   - 或使用class+nth-child: .option-item:nth-child(2)
   - 或使用属性选择器: input[value="B"], input[name="q1"][value="2"]
   - 对于radio/checkbox，选择器应指向input元素本身
   - 对于可点击的div/label，选择器应指向该可点击元素
4. 仔细分析HTML结构，确保选择器准确无误
5. 【不要返回答案】这一步只需要识别题目结构

${contentIntro}

HTML内容：
${payload}`;

    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          action: "analyzeHTML",
          config,
          prompt,
        },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }

          if (!response.success) {
            reject(new Error(response.error));
            return;
          }

          try {
            const result = parseAIResponse(response.data);
            resolve(result);
          } catch (e) {
            reject(new Error("解析AI响应失败: " + e.message));
          }
        }
      );
    });
  }

  // 使用AI分析结果创建题目列表（不含答案，答案在答题阶段逐题获取）
  function scanWithAISelectors(aiResult) {
    questions = [];
    answeredCount = 0;

    if (!aiResult.questions || aiResult.questions.length === 0) {
      return 0;
    }

    // 使用AI返回的题目结构数据（不含答案）
    aiResult.questions.forEach((q, index) => {
      const question = {
        index,
        type: q.type || "single",
        text: q.text || "",
        answer: null, // 答案在答题阶段获取
        explanation: null,
        options: [],
        inputs: [],
        answered: false,
      };

      // 处理选项（单选/多选题）
      if (q.options && q.options.length > 0) {
        question.options = q.options.map((opt) => ({
          label: opt.label,
          text: opt.text,
          selector: opt.selector,
          element: opt.selector ? safeQuerySelector(opt.selector) : null,
        }));
      }

      // 处理填空题输入框
      if (q.type === "fill" && q.inputs && q.inputs.length > 0) {
        question.inputs = q.inputs.map((inp) => ({
          selector: inp.selector,
          element: inp.selector ? safeQuerySelector(inp.selector) : null,
        }));
      }

      questions.push(question);
      console.log(
        `[AI答题助手] 题目${index + 1}:`,
        question.text.substring(0, 50)
      );
    });

    updateStats();
    return questions.length;
  }

  // 安全的querySelector，捕获无效选择器错误
  function safeQuerySelector(selector) {
    if (!selector) return null;
    try {
      return document.querySelector(selector);
    } catch (e) {
      console.warn("[AI答题助手] 无效的选择器:", selector, e);
      return null;
    }
  }

  // Remove duplicate questions
  function removeDuplicates(questions) {
    const seen = new Set();
    return questions.filter((q) => {
      const key = q.text.substring(0, 100);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // Clean text
  function cleanText(text) {
    return text
      .replace(/\s+/g, " ")
      .replace(/[\r\n]+/g, " ")
      .trim()
      .substring(0, 1000);
  }

  // Start answering questions
  async function startAnswering() {
    if (isRunning) return;
    isRunning = true;
    const visited = new Set();
    let completed = false;
    try {
      for (let page = 0; isRunning && (autoContinue || page < 1); page++) {
        if (page > 0) {
          questions = [];
          answeredCount = 0;
          pageTouched = false;
          if (!isSkippableCommentPage()) {
            const scan = await new Promise((resolve) => handleScan(resolve));
            if (!scan?.success && !isPassiveCoursePage() && (!skipUnfinished || scan?.authError)) {
              if (!scan?.authError) sendLog("warning", "下一页未识别到题目，自动流程停在当前页");
              break;
            }
          }
        }
        const marker = getCoursePageMarker();
        if (visited.has(marker)) {
          sendLog("warning", "检测到重复页面，自动流程已停止");
          break;
        }
        visited.add(marker);

        if (!questions.length && !isSkippableCommentPage() && !isPassiveCoursePage()) {
          if(skipUnfinished && !aiAuthFailed && !rateLimitNotice()){
            recordSkippedPage(marker,'未识别到可填写题目或控件暂不支持');
            if(!await advanceCoursePage(marker)){completed=lastAdvanceStatus==='end';break;}
            continue;
          }
          sendLog('warning', '当前练习页未识别到可填写题目，停在本页等待检查');
          break;
        }
        if (autoContinue && isSkippableCommentPage()) {
          recordSkippedPage(marker,'视频评论/Discussion 页面，按既有规则跳过');
          if (!await advanceCoursePage(marker)) { completed = lastAdvanceStatus==="end"; break; }
          continue;
        }
        if (!questions.length && isPassiveCoursePage() && autoContinue) {
          sendLog('info', '本页无答题控件，继续下一页');
          if (!await advanceCoursePage(marker)) { completed = lastAdvanceStatus==="end"; break; }
          continue;
        }
        const filled = await answerCurrentPage();
        if (!isRunning) break;
        // 一旦向本页写入了答案，先提交再考虑跳页；部分题目未答时明确记录。
        if (pageTouched && window.location.hostname === 'ucontent.unipus.cn' &&
            !await submitCurrentPage({ allowPartial: !filled })) {
          if(skipUnfinished && !aiAuthFailed && !rateLimitNotice()){
            recordSkippedPage(marker,'已尝试提交，但尚未确认提交成功');
            if(!await advanceCoursePage(marker)){completed=lastAdvanceStatus==='end';break;}
            continue;
          }
          break;
        }
        if (!autoContinue) { completed = filled; break; }
        if (!filled) {
          if(skipUnfinished && !aiAuthFailed && !rateLimitNotice()){
            recordSkippedPage(marker,'仍有未完成题目');
            if(!await advanceCoursePage(marker)){completed=lastAdvanceStatus==='end';break;}
            continue;
          }
          sendLog('warning', pageTouched ? '已尝试提交已填写内容；仍有未完成题目，保留本页' : '本页尚未获得或完整写入答案，保留本页，不自动跳过');
          break;
        }
        if (!await advanceCoursePage(marker)) { completed = lastAdvanceStatus==="end"; break; }
      }
    } finally {
      isRunning = false;
      await chrome.storage.local.set({lastUnipusRun:{visited:[...visited],skipped:skippedPages,time:Date.now(),reachedEnd:completed}});
      sendComplete(completed);
    }
  }

  async function answerCurrentPage() {
    if (questions.length === 0) {
      sendLog("warning", "请先扫描题目");
      return false;
    }

    sendLog("info", `开始答题，共 ${questions.length} 道题目`);

    for (let i = 0; i < questions.length; i++) {
      if (!isRunning) {
        sendLog("warning", "答题已停止");
        break;
      }

      const question = questions[i];

      if (question.answered) {
        continue;
      }

      // 找到第一个有效的选项元素用于滚动定位和高亮
      const firstElement = findFirstValidElement(question);

      if (firstElement) {
        // 滚动到题目位置
        scrollToElement(firstElement);
        await sleep(300);

        // 高亮当前题目区域
        const questionContainer = findQuestionContainer(firstElement);
        if (questionContainer) {
          highlightElement(questionContainer);
        }
      }

      sendLog(
        "info",
        `正在处理第 ${i + 1}/${questions.length} 题: ${question.text.substring(
          0,
          30
        )}...`
      );

      try {
        // 逐题调用AI获取答案
        sendLog("info", `正在获取第 ${i + 1} 题的答案...`);
        const answer = await getAnswerWithBackoff(question);
        if (cancelRequested || !isRunning) break;

        if (answer && answer.answer) {
          question.answer = answer.answer;
          question.explanation = answer.explanation;
          const applied = await applyAnswerDirectly(question);
          if (!applied) {
            sendLog("warning", `第 ${i + 1} 题答案未完整写入页面，暂停提交`);
            if (firstElement) removeHighlight(findQuestionContainer(firstElement));
            continue;
          }
          question.answered = true;
          answeredCount++;
          updateStats();
          // 发送统计
          chrome.runtime.sendMessage({
            action: "trackStats",
            event: "question_answered",
          });
          sendLog(
            "success",
            `第 ${i + 1} 题已完成，答案: ${JSON.stringify(question.answer)}`
          );
        } else {
          sendLog("warning", `第 ${i + 1} 题未能获取答案`);
        }
      } catch (error) {
        if (isAiAuthError(error)) {
          aiAuthFailed = true;
          sendLog('error', '当前 AI 请求收到 401；请在设置中测试实际启用的配置。已保留本页，未把本题标记为完成。');
          break;
        }
        sendLog("error", `第 ${i + 1} 题处理失败: ${error.message}`);
        console.error("[AI答题助手] 答题错误:", error);
      }

      // 移除高亮
      if (firstElement) {
        const questionContainer = findQuestionContainer(firstElement);
        if (questionContainer) {
          removeHighlight(questionContainer);
          // 添加已完成标记
          if (question.answered) markAsCompleted(questionContainer);
        }
      }

      // Wait before next question
      await sleep(500);
    }

    return isRunning && questions.length > 0 && questions.every((q) => q.answered);
  }

  function getCoursePageMarker() {
    const menus = [...document.querySelectorAll('.pc-slider-menu-micro')];
    const menuIndex = menus.findIndex((el) => el.classList.contains('pc-menu-activity'));
    const task = document.querySelector('.pc-header-tasks-row .pc-header-task-activity');
    const stage = document.querySelector('.pc-header-tabs-container .pc-header-tab-activity,.pc-header-sections-row .pc-header-section-activity,.pc-header-stage-activity');
    return `${location.href}|${menuIndex}|${stage?.textContent || ''}|${task?.getAttribute('title') || task?.textContent || ''}`;
  }

  function isPassiveCoursePage() {
    if (window.UnipusPageModel) {
      const state = window.UnipusPageModel.inspect().status;
      if (state !== 'legacy') return ['review', 'passive'].includes(state);
    }
    const root = document.querySelector('.pc-content-container') ||
      document.querySelector('.pc-main-container') || document;
    if (root.querySelector('.fe-scoop .ant-dropdown-trigger.user-answer')) return false;
    if (root.querySelector('.question-common-abs-choice, .question-common-abs-reply')) return false;
    const intro = (root.textContent || '').slice(0, 900);
    const hasMedia = !!root.querySelector('video, [class*="video-player"], [class*="video-wrapper"]');
    if (hasMedia && /watch the video|观看视频|观看.*视频|learn effective language use/i.test(intro)) return true;
    // 播放器内部也有 input（进度条/音量），不应被误判为答题框。
    return !root.querySelector('input:not([type="range"]):not([type="hidden"]), textarea, [contenteditable="true"]');
  }

  function isSkippableCommentPage() {
    if (window.UnipusPageModel) {
      const state = window.UnipusPageModel.inspect().status;
      if (state !== 'legacy') return state === 'discussion';
    }
    const root = document.querySelector('.pc-content-container') ||
      document.querySelector('.pc-main-container') || document;
    const task = document.querySelector('.pc-header-tasks-row .pc-header-task-activity')?.textContent || '';
    // 这组 Discussion 1/2/3 为评论页；其评论框复用 question-common-abs-reply 类，
    // 因此必须在通用“评分题”检测前按活动页签跳过。
    if (/^Discussion\s*[123]$/i.test(task.trim())) return true;
    const text = `${task} ${(root.textContent || '').slice(0, 3000)}`;
    const comment = root.querySelector('[class*="comment"], [placeholder*="评论"], [placeholder*="comment"], textarea, [contenteditable="true"]');
    const video = root.querySelector('video, [class*="video"]');
    const graded = root.querySelector('.question-common-abs-choice, .question-common-abs-reply');
    const submit = [...root.querySelectorAll('button,a,[role="button"]')]
      .some((el) => /^提\s*交$|^Submit$/i.test((el.textContent || '').trim()));
    // Viewing China 等页的 Discussion 只有“全部评论/我来评论/发布”，并非评分题。
    // 有些评论框不暴露 textarea 或 comment 类，改用整组页面文案识别。
    const hasCommentList = /全部评论|all\s+comments/i.test(text);
    const hasCommentEditor = /我来评论|write\s+a\s+comment|5000\s*字符|5000\s*characters/i.test(text) || !!comment;
    const publish = [...root.querySelectorAll('button,a,[role="button"]')]
      .some((el) => /^发\s*布$|^Post$/i.test((el.textContent || '').trim()));
    // 采集页可出现“发 布”，且页签名暂时为空；整组评论特征比页签名可靠。
    const discussionComment = hasCommentList && hasCommentEditor &&
      (publish || /发\s*布/.test(text)) &&
      (!task.trim() || /\bDiscussion\s*\d*\b|讨论\s*\d*/i.test(task));
    if (discussionComment && !graded) return true;
    return !!comment && !graded &&
      ((!!video && /评论|comment|discussion|讨论/i.test(text)) ||
        (!submit && /视频评论|video\s+comment|discussion|讨论/i.test(task)));
  }

  function rateLimitNotice() {
    const notices = [...document.querySelectorAll('.ant-message, .ant-notification, [role="alert"]')];
    return notices.some((el) => isRateLimitText(el.textContent || ''));
  }

  function isRateLimitText(text) {
    return /操作过于频繁|请求过于频繁|too many requests|rate limit|\b429\b/i.test(String(text));
  }

  function isAiAuthError(error) {
    return /(?:\b401\b|令牌已过期|验证不正确)/i.test(String(error?.message || error));
  }

  async function paceAction(label) {
    const gap = 1800 + Math.floor(Math.random() * 1400);
    await sleep(Math.max(0, lastActionAt + gap - Date.now()));
    if (cancelRequested) return false;
    for (let retry = 0; rateLimitNotice() && retry < 3; retry++) {
      const delay = 5000 * (2 ** retry) + Math.floor(Math.random() * 1000);
      sendLog('warning', `${label}遇到频率提示，等待 ${Math.ceil(delay / 1000)} 秒后重试`);
      await sleep(delay);
      if (cancelRequested) return false;
    }
    if (rateLimitNotice()) {
      sendLog('warning', `${label}频率提示仍在，自动流程停在当前页`);
      return false;
    }
    lastActionAt = Date.now();
    return true;
  }

  async function getAnswerWithBackoff(question) {
    for (let retry = 0; retry < 3; retry++) {
      if (!await paceAction('读取答案')) return null;
      try {
        return await getAIAnswerForQuestion(question);
      } catch (error) {
        if (!isRateLimitText(error.message) || retry === 2) throw error;
        const delay = 5000 * (2 ** retry) + Math.floor(Math.random() * 1000);
        sendLog('warning', `答案请求受限，等待 ${Math.ceil(delay / 1000)} 秒后重试`);
        await sleep(delay);
      }
    }
    return null;
  }

  async function submitCurrentPage({ allowPartial = false } = {}) {
    // 完整页要求全部空位非空；部分页允许提交已填写内容。
    const blanks = [...document.querySelectorAll('.question-common-abs-reply input, .question-common-abs-reply textarea')];
    if (!allowPartial && blanks.some((el) => !String(el.value || '').trim())) {
      sendLog('warning', `仍有 ${blanks.filter((el) => !String(el.value || '').trim()).length} 个空未填写，停止自动提交`);
      return false;
    }
    const root = document.querySelector('.pc-main-container') || document;
    const submit = [...root.querySelectorAll('button,a,[role="button"]')].find((el) =>
      /^提\s*交$|^Submit$/i.test((el.textContent || '').trim()) &&
      el.getBoundingClientRect().width > 0 && !el.hasAttribute('disabled')
    );
    if (!submit) {
      sendLog('warning', '本页写入了答案，但没有找到提交按钮；停在本页');
      return false;
    }
    if (!await paceAction('提交')) return false;
    submit.click();
    sendLog('info', '已点击当前页“提交”');
    await sleep(900);
    if (cancelRequested) return false;
    const confirm = [...document.querySelectorAll('.ant-modal-confirm-btns button, .ant-modal-footer button')]
      .find((el) => /^(确定|确认|提交|OK|Confirm)$/i.test((el.textContent || '').trim()));
    if (confirm) {
      confirm.click();
      await sleep(700);
    }
    if (!await paceAction('提交确认')) return false;
    const error = document.querySelector('.ant-message-error, .ant-notification-notice-error');
    if (error && error.getBoundingClientRect().width > 0) {
      sendLog('warning', `提交提示错误：${(error.textContent || '').trim()}`);
      return false;
    }
    for (let attempt = 0; attempt < 30 && !cancelRequested; attempt++) {
      const acknowledgement = document.querySelector('.ant-message-success,.ant-notification-notice-success');
      const review = root.querySelector('.component-analysis');
      if ((acknowledgement && acknowledgement.getBoundingClientRect().width > 0) ||
          (review && review.getBoundingClientRect().width > 0)) {
        submittedGroups = questions.filter(q=>q.answered).length;
        updateStats();
        const rows=window.UnipusPageModel?.reviewAnswers?.()||[];
        if(rows.length)chrome.runtime.sendMessage({type:'answerPreview',source:'网页提交后解析',rows,note:'请核对批改结果；已提交不等同全部答对',page:getCoursePageMarker()});
        return true;
      }
      const lateError = document.querySelector('.ant-message-error,.ant-notification-notice-error');
      if (lateError && lateError.getBoundingClientRect().width > 0) {
        sendLog('warning', `提交提示错误：${(lateError.textContent || '').trim()}`);
        return false;
      }
      await sleep(200);
    }
    sendLog('warning', '已点击提交，但尚未收到成功提示或答案解析；保留本页，请核对提交结果');
    return false;
  }

  async function advanceCoursePage(before) {
    lastAdvanceStatus = "failed";
    if (getCoursePageMarker() !== before) {
      sendLog('warning', '页面已被切换，停止当前翻页动作');
      return false;
    }
    const oldContent = courseContentFingerprint();
    const activeTask = document.querySelector('.pc-header-tasks-row .pc-header-task-activity');
    const nextTask = activeTask?.nextElementSibling;
    const activeStage = document.querySelector('.pc-header-tabs-container .pc-header-tab-activity,.pc-header-sections-row .pc-header-section-activity,.pc-header-stage-activity');
    const nextStage = activeStage?.nextElementSibling;
    const menus = [...document.querySelectorAll('.pc-slider-menu-micro')];
    const menuIndex = menus.findIndex(el => el.classList.contains('pc-menu-activity'));
    const nextMenu = menuIndex >= 0 ? menus[menuIndex + 1] : null;
    // Current pages attach their stage handler to the inner view, not the outer tab.
    const stageTarget = nextStage?.querySelector('.pc-tab-view-container') || nextStage;
    const target = nextTask?.classList.contains('pc-task') ? nextTask : (stageTarget || nextMenu);
    if (!target) {
      lastAdvanceStatus = 'end';
      sendLog('success', '已到目录末页');
      return false;
    }
    const title = target.getAttribute('title') || target.querySelector('.pc-menu-node-name')?.textContent || target.textContent?.trim();
    if (!await paceAction('翻页')) return false;
    target.scrollIntoView({ block: 'nearest' });
    target.click();
    let observedMarker = null, lastFingerprint = null, stable = 0;
    for (let i = 0; i < 45 && isRunning && !cancelRequested; i++) {
      await sleep(200);
      const marker = getCoursePageMarker();
      const fingerprint = courseContentFingerprint();
      const root = document.querySelector('.pc-content-container') || document.querySelector('.pc-main-container');
      const pending = window.UnipusPageModel?.inspect().status === 'pending';
      if (marker === before || fingerprint === oldContent || !root ||
          !root.textContent?.trim() || root.querySelector('.ant-spin-spinning') || pending) {
        stable = 0;
        continue;
      }
      if (observedMarker === marker && lastFingerprint === fingerprint) stable++;
      else stable = 0;
      observedMarker = marker;
      lastFingerprint = fingerprint;
      if (stable >= 2) {
        lastAdvanceStatus = 'advanced';
        sendLog('info', '已翻至：' + title + '，新内容已加载');
        return true;
      }
    }
    sendLog('warning', '页签切换后新内容尚未确认：' + title + '，保留当前页');
    return false;
  }

  function courseContentFingerprint() {
    const root = document.querySelector('.pc-content-container') ||
      document.querySelector('.pc-main-container');
    return `${(root?.textContent || '').replace(/\s+/g, ' ').slice(0, 600)}|` +
      `${root?.querySelectorAll('.fe-scoop,.question-common-abs-choice,.question-common-abs-reply').length || 0}`;
  }

  // 找到题目中第一个有效的元素用于定位
  function findFirstValidElement(question) {
    if (question.dropdownElement) return question.dropdownElement;
    if (question.options && question.options.length > 0) {
      for (const opt of question.options) {
        if (opt.element) return opt.element;
        // 尝试重新查询
        if (opt.selector) {
          const el = safeQuerySelector(opt.selector);
          if (el) return el;
        }
      }
    }
    if (question.inputs && question.inputs.length > 0) {
      for (const inp of question.inputs) {
        if (inp.element) return inp.element;
        if (inp.selector) {
          const el = safeQuerySelector(inp.selector);
          if (el) return el;
        }
      }
    }
    return null;
  }

  // 根据选项元素向上查找题目容器（精确定位到单道题）
  function findQuestionContainer(element) {
    if (!element) return null;

    // 优先使用腾讯问卷的精确容器选择器
    const tencentContainer = element.closest(
      "section.question[data-question-id]"
    );
    if (tencentContainer) {
      return tencentContainer;
    }

    // 先找到这个选项所属的所有同级选项（同一道题的选项）
    const elementInput =
      element.tagName === "INPUT" ? element : element.querySelector("input");
    const inputName = elementInput?.name;

    let current = element.parentElement;
    let bestContainer = null;
    let depth = 0;
    const maxDepth = 4; // 限制层数，只找最近的容器

    while (current && current !== document.body && depth < maxDepth) {
      // 检查当前容器内有多少组选项（通过不同的 name 判断）
      const allInputs = current.querySelectorAll(
        'input[type="radio"], input[type="checkbox"]'
      );
      const names = new Set();
      allInputs.forEach((inp) => {
        if (inp.name) names.add(inp.name);
      });

      // 如果这个容器只包含一道题的选项（1个name），就是我们要的
      if (names.size === 1 && allInputs.length >= 2) {
        bestContainer = current;
        // 继续向上找一层，看看父元素是否也只包含这一道题
        // 但不要找太多层
      } else if (names.size > 1) {
        // 包含多道题了，停止，使用上一个找到的容器
        break;
      }

      // 如果没有 input，检查是否有可点击的选项元素
      if (allInputs.length === 0) {
        const options = current.querySelectorAll(
          '.option, [class*="option"], [class*="choice"]'
        );
        if (options.length >= 2 && options.length <= 6) {
          bestContainer = current;
        }
      }

      current = current.parentElement;
      depth++;
    }

    // 如果没找到，返回选项的直接父元素的父元素
    return (
      bestContainer ||
      element.parentElement?.parentElement ||
      element.parentElement ||
      element
    );
  }

  // 标记题目为已完成
  function markAsCompleted(element) {
    if (!element) return;

    // 添加完成样式
    // 检查是否已有标记
    if (element.dataset.aiAnswerCompleted === "true") return;

    // 创建完成标记
    removeHighlight(element);
    element.dataset.aiAnswerCompleted = "true";
    element.style.outline = "2px solid #22c55e";
    element.style.outlineOffset = "2px";
  }

  // 直接应用答案（使用AI返回的选择器）
  async function applyAnswerDirectly(question) {
    // 标准化题型名（模板识别名 → 内部名）
    const qtype = normalizeQuestionType(question.type);
    switch (qtype) {
      case "single":
        return await applySingleAnswerDirectly(question);
      case "dropdown_choice":
        return await applyDropdownChoiceAnswer(question);
      case "multiple":
        return await applyMultipleAnswerDirectly(question);
      case "fill":
      case "translation":
      case "rewrite_sentence":
      case "grammar_fill":
        return await applyFillAnswerDirectly(question);
      case "banked_cloze":
        return await applyBankedClozeAnswer(question);
    }
    return false;
  }

  // 题型名标准化
  function normalizeQuestionType(type) {
    const map = {
      single_choice: "single",
      multiple_choice: "multiple",
      choice: "single",
      fill_blank: "fill",
      blank_filling: "fill",
      blank: "fill",
    };
    return map[type] || type;
  }

  // 单选题 - 直接点击对应选项
  async function applySingleAnswerDirectly(question) {
    const answerRaw = String(question.answer).trim();
    const answerUpper = answerRaw.toUpperCase();

    // 尝试按字母匹配
    for (const option of question.options) {
      if (option.label.toUpperCase() === answerUpper) {
        return await clickOptionElement(option);
      }
    }

    // 回退：按数字索引匹配
    const idx = parseInt(answerRaw);
    if (!isNaN(idx) && idx >= 0 && idx < question.options.length) {
      return await clickOptionElement(question.options[idx]);
    }
    return false;
  }

  async function clickOptionElement(option) {
    let element = option.element;
    if (!element && option.selector) {
      element = safeQuerySelector(option.selector);
    }
    if (element) {
      if (optionSelected(element)) return true;
      await clickElement(element);
      await sleep(150);
      console.log(`[AI答题助手] 单选已点击: ${option.label}`);
      return window.location.hostname !== 'ucontent.unipus.cn' || optionSelected(element);
    } else {
      console.warn(`[AI答题助手] 找不到选项元素: ${option.label}, selector: ${option.selector}`);
      return false;
    }
  }

  // 多选题 - 点击所有正确选项
  function optionSelected(element) {
    const input = element.matches?.('input') ? element : element.querySelector?.('input[type="checkbox"],input[type="radio"]');
    return !!input?.checked || element.getAttribute('aria-checked') === 'true' ||
      /(?:^|\s)(?:selected|checked|active|isSelected|isChecked)(?:\s|$)/i.test(String(element.className || ''));
  }

  async function applyMultipleAnswerDirectly(question) {
    const raw = Array.isArray(question.answer) ? question.answer : [question.answer];
    const answers = [...new Set(raw.flatMap(value => {
      const code = String(value ?? '').trim().toUpperCase();
      return /^[A-Z](?:[\s,;|/]*[A-Z])*$/.test(code)
        ? (code.match(/[A-Z]/g) || []) : [];
    }))];

    console.log(`[AI答题助手] 多选答案:`, answers);
    if (answers.length === 0 || answers.some(a => !question.options.some(o => o.label.toUpperCase() === a))) return false;
    let matched = 0;

    for (const option of question.options) {
      {
        let element = option.element;

        if (!element && option.selector) {
          element = safeQuerySelector(option.selector);
        }

        if (element) {
          if (cancelRequested) return false;
          const selected = optionSelected(element);
          const wanted = answers.includes(option.label.toUpperCase());
          if (!!selected !== wanted) {
            // 与目标集合对齐，避免重试时留下旧的错误勾选。
            const target = element.querySelector('input[type="checkbox"]') || element;
            target.click();
            pageTouched = true;
          }
          console.log(`[AI答题助手] 多选已点击: ${option.label}`);
          await sleep(200);
          if (optionSelected(element) !== wanted) return false;
          if (wanted) matched++;
        } else {
          console.warn(
            `[AI答题助手] 找不到选项元素: ${option.label}, selector: ${option.selector}`
          );
        }
      }
    }
    return matched === answers.length;
  }

  async function applyDropdownChoiceAnswer(question) {
    const raw = Array.isArray(question.answer) ? question.answer[0] : question.answer;
    const normalize = value => toPlainAnswerText(value).replace(/\s+/g, ' ').trim().toLowerCase();
    const answer = normalize(raw);
    const option = question.options.find(opt => [opt.label, opt.value, opt.text].some(v => v != null && normalize(v) === answer));
    if (!option) return false;
    const trigger = question.dropdownElement;
    if (!trigger?.isConnected) return false;
    const expected = normalize(option.value ?? option.label);
    const selectedText = () => normalize(trigger.querySelector('.user-answer-text')?.textContent || trigger.textContent);
    if (selectedText() === expected && !trigger.classList.contains('empty')) return true;
    trigger.click();
    let item;
    for (let attempt = 0; attempt < 15 && !cancelRequested; attempt++) {
      await sleep(100);
      const menus = [...document.querySelectorAll('.scoop-select-dropdown')].filter(el =>
        el.getBoundingClientRect().width > 0 && getComputedStyle(el).visibility !== 'hidden');
      const matches = menus.flatMap(menu => [...menu.querySelectorAll('.select-option')])
        .filter(el => normalize(el.textContent) === expected);
      if (matches.length === 1) { item = matches[0]; break; }
    }
    if (!item) return false;
    await clickElement(item);
    for (let attempt = 0; attempt < 10 && !cancelRequested; attempt++) {
      await sleep(100);
      if (selectedText() === expected && !trigger.classList.contains('empty')) return true;
    }
    return false;
  }

  // 答案接口可能返回 <p>...</p> 等富文本；输入框只接受可读文字。
  function toPlainAnswerText(value) {
    const source = String(value ?? "");
    if (!/<\/?[a-z][^>]*>|&(?:#\d+|#x[\da-f]+|[a-z]+);/i.test(source)) {
      return source;
    }
    const html = source
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(?:p|div|li|h[1-6]|blockquote)>/gi, "\n");
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("script,style,iframe").forEach((node) => node.remove());
    return (doc.body.textContent || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  // 填空题 - 填写答案（每个空填对应的答案）
  async function applyFillAnswerDirectly(question) {
    let answers = question.answer;

    // 确保answers是数组
    if (!Array.isArray(answers)) {
      answers = [answers];
    }

    // 解析输入框列表
    const inputElements = [];
    for (const inputInfo of question.inputs) {
      let element = inputInfo.element;
      if (!element && inputInfo.selector) {
        element = safeQuerySelector(inputInfo.selector);
      }
      if (element) {
        inputElements.push(element);
      }
    }

    if (inputElements.length === 0) {
      console.warn(`[AI答题助手] 找不到填空题输入框`);
      return false;
    }

    if (question.openResponse && inputElements.length === 1 && answers.length &&
        answers.every(v=>typeof v==='string'||typeof v==='number')) {
      answers = [answers.map(toPlainAnswerText).filter(Boolean).join('\n')];
      question.answer = answers;
    }
    if (answers.length !== inputElements.length) {
      console.warn(`[AI答题助手] 填空数量不匹配: ${answers.length}/${inputElements.length}`);
      return false;
    }

    // 每个空填对应答案
    for (let i = 0; i < inputElements.length; i++) {
      const val = toPlainAnswerText(answers[i]);
      if (!val) return false;
      await fillInput(inputElements[i], val);
      await sleep(100);
      if (inputElements[i].value !== val) return false;
    }
    console.log(`[AI答题助手] 填空已填写: ${answers.map(toPlainAnswerText).join(', ')}`);
    return true;
  }

  // 选词填空题 - 点击选项词 → 点击对应的空，再直接填入 value
  async function applyBankedClozeAnswer(question) {
    let answers = question.answer;
    if (!Array.isArray(answers)) { answers = [answers]; }

    // 使用 question 已解析的 inputs（空位）
    const blanks = question.inputs
      .map(inp => inp.element || (inp.selector ? safeQuerySelector(inp.selector) : null))
      .filter(Boolean);
    if (answers.length !== blanks.length || !blanks.length) return false;

    for (let i = 0; i < Math.min(answers.length, blanks.length); i++) {
      const word = String(answers[i]).trim();
      const blank = blanks[i];

      // 步骤1: 点击对应的候选词
      const allOptionEls = document.querySelectorAll('.option, [class*="option"]');
      for (const opt of allOptionEls) {
        if (opt.textContent.trim() === word) {
          opt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
          opt.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
          opt.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          await sleep(200);
          break;
        }
      }

      // 步骤2: 点击对应的空位（触发 SPA 状态）
      blank.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      blank.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
      blank.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await sleep(150);
      blank.dispatchEvent(new Event('input', { bubbles: true }));
      blank.dispatchEvent(new Event('change', { bubbles: true }));

      // 步骤3: 直接用 fillInput 填入 value（兼容 React 受控组件）
      await fillInput(blank, word);
      await sleep(100);
    }
    console.log('[AI答题助手] 选词填空已填入: ' + answers.join(', '));
    return blanks.every((blank, i) => blank.value === String(answers[i]).trim());
  }

  // 填写输入框（兼容 React/Vue 受控组件）
  async function fillInput(element, value) {
    // 聚焦
    element.focus();
    await sleep(50);

    // React 受控组件：通过原生 setter 触发框架响应
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    ).set;
    const nativeTextAreaSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value'
    ).set;
    const setter = element.tagName === 'TEXTAREA' ? nativeTextAreaSetter : nativeSetter;

    // 清空
    setter.call(element, '');
    element.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(30);

    // 写入新值
    setter.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    if (value) pageTouched = true;

    // 模拟键盘输入
    element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
    element.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));

    element.blur();
  }

  // Stop answering
  function stopAnswering() {
    isRunning = false;
    autoContinue = false;
    cancelRequested = true;
  }

  // 逐题获取AI答案（只发送单道题目，不发送整页HTML）
  async function getAIAnswerForQuestion(question) {
    // U校园快速路径：答案已从 API 获取
    if (
      question._unipusAnswer &&
      question.answer !== null &&
      question.answer !== undefined
    ) {
      console.log(
        "[AI答题助手] 使用 U校园 API 答案:",
        JSON.stringify(question.answer)
      );
      sendLog('info', '答案来源：平台返回，本题未调用 AI');
      return {
        answer: question.answer,
        explanation: "U校园服务端正解",
      };
    }

    // WeLearn 快速路径：答案已从数据 HTML 获取
    if (
      question._welearnAnswer &&
      question.answer !== null &&
      question.answer !== undefined
    ) {
      console.log(
        "[AI答题助手] 使用 WeLearn 数据 HTML 答案:",
        JSON.stringify(question.answer)
      );
      return {
        answer: question.answer,
        explanation: "WE Learn 数据正解",
      };
    }

    // 听力题优先使用上面的平台答案；无答案且无原文时不让文本模型猜音频。
    let listeningTranscript = '';
    if (window.location.hostname === 'ucontent.unipus.cn') {
      const questionRoot=question.element?.closest('.pc-content-container') || document.querySelector('.pc-content-container') || document;
      listeningTranscript = [...questionRoot.querySelectorAll(
        '.transcript,[class*="transcript"],[class*="subtitle"],[class*="caption-text"]'
      )].map(el => (el.innerText || '').trim()).filter(Boolean).join('\n').slice(0, 8000);
      const pageIntro = question.direction || questionRoot.querySelector('.abs-direction')?.textContent || '';
      const hasMedia = !!questionRoot.querySelector('audio,video,.audio-material-wrapper,.question-audio');
      if (hasMedia && /\b(listen|listening|podcast|audio|watch)\b/i.test(pageIntro) && !listeningTranscript) {
        sendLog('warning', '音视频题缺少可读原文，且平台答案未取得；本题暂不填写。');
        return null;
      }
    }

    let prompt = `请回答以下${getTypeLabel(question.type)}：\n\n`;
    prompt += `题目：${question.text}\n\n`;
    if(question.openResponse){
      prompt += '这是开放式表达练习，请给出简洁的英文示例回答。示例经历保持前后一致，不把题目误当成音视频听写。\n';
      const previous=questions.filter(q=>q!==question&&q.openResponse&&q.answered).map(q=>({question:q.text,answer:q.answer}));
      if(previous.length)prompt+='同页已生成的示例，请延续相同经历：'+JSON.stringify(previous)+'\n';
      sendLog('info','开放式简答：生成AI示例回答，可按你的真实经历修改');
    }
    if (question.direction) prompt += `作答要求：${question.direction}\n\n`;
    if (question.context) prompt += `阅读材料：${question.context}\n\n`;
    if (window.location.hostname === 'ucontent.unipus.cn' && normalizeQuestionType(question.type) === 'fill') {
      const page = question.element?.closest('.question-common-abs-question-container');
      const passage = page?.querySelector('.question-common-abs-material')?.textContent?.trim();
      const outline = question.element?.textContent?.trim();
      if (passage) prompt += `参考材料：\n${passage.slice(0, 12000)}\n\n`;
      if (outline) prompt += `填空所在内容：\n${outline.slice(0, 5000)}\n\n`;
    }
    if (listeningTranscript) prompt += `听力原文：\n${listeningTranscript}\n\n`;

    if (question.options && question.options.length > 0) {
      prompt += "选项：\n";
      question.options.forEach((opt) => {
        prompt += `${opt.label}. ${opt.text}\n`;
      });
      prompt += "\n";
    }

    if (
      normalizeQuestionType(question.type) === "fill" &&
      question.inputs &&
      question.inputs.length > 1
    ) {
      prompt += `（共有 ${question.inputs.length} 个空需要填写，每空仅选一种写法）\n\n`;
    }

    if (normalizeQuestionType(question.type)==='fill' && question.inputs?.length===1) prompt+='本题只有一个回答框，answer必须是仅包含一个完整回答的数组。\n';
    if (question.type === "banked_cloze" && question.wordBank && question.wordBank.length > 0) {
      prompt += `可选词汇（${question.wordBank.length}个）：${question.wordBank.join('、')}\n`;
      prompt += '请从可选词汇中选择最合适的词填入每个空，每个词最多用一次。\n\n';
    }

    prompt += `请严格按照JSON格式返回答案：
{
  "type": "${question.type}",
  "answer": ${
    question.type === "single" || question.type === "dropdown_choice"
      ? '"选项字母如B"'
      : question.type === "multiple"
      ? '["A", "C"]'
      : question.type === "banked_cloze"
      ? '["词1", "词2", ...]'
      : '["答案1", "答案2"]'
  },
  "explanation": "简短解释"
}

注意：
- 单选题answer为单个字母，如 "B"
- 排序/配对题answer按题号返回不重复的选项字母数组，数量与目标位置完全一致\n- 多选题answer为字母数组，如 ["A", "C"]
- 选词填空answer为词语数组，按空格顺序排列，如 ["importance", "however", "therefore"]
- 填空题answer为答案数组，如 ["答案1"] 或 ["答案1", "答案2"]
- 只返回JSON，不要其他内容`;

    sendLog('info', `答案来源：AI 请求（模型 ${config?.model || '未配置'}）`);
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          action: "callAI",
          config,
          prompt,
        },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }

          if (!response.success) {
            reject(new Error(response.error));
            return;
          }

          try {
            const answer = parseAIResponse(response.data);
            // 存入题库
            if (window.questionBank && answer && answer.answer) {
              window.questionBank.store('unipus', question.text, answer.answer, question.type);
            }
            resolve(answer);
          } catch (e) {
            reject(new Error("解析AI响应失败: " + e.message));
          }
        }
      );
    });
  }

  // Get AI answer for a question (legacy, kept for compatibility)
  async function getAIAnswer(question) {
    return getAIAnswerForQuestion(question);
  }

  // Build prompt for AI
  function buildPrompt(question) {
    let prompt = `题目类型: ${getTypeLabel(question.type)}\n\n`;
    prompt += `题目: ${question.text}\n\n`;

    if (question.options.length > 0) {
      prompt += "选项:\n";
      question.options.forEach((opt) => {
        prompt += `${opt.label}. ${opt.text}\n`;
      });
    }

    if (question.type === "fill") {
      prompt += `\n这是一道填空题，请给出填空的答案。`;
      if (question.inputs.length > 1) {
        prompt += `共有 ${question.inputs.length} 个空需要填写。`;
      }
    }

    return prompt;
  }

  // Get type label
  function getTypeLabel(type) {
    const labels = {
      single: "单选题",
      dropdown_choice: "下拉单选题",
      sequence: "排序/配对题",
      multiple: "多选题",
      fill: "填空题",
      banked_cloze: "选词填空题",
      translation: "翻译题",
      rewrite_sentence: "句子改写题",
      grammar_fill: "语法填空题",
    };
    return labels[type] || type;
  }

  // Parse AI response
  function parseAIResponse(responseText) {
    // Try to extract JSON from response
    let jsonStr = responseText;

    // Handle markdown code blocks
    const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1];
    }

    // Try to find JSON object
    const objMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (objMatch) {
      jsonStr = objMatch[0];
    }

    const parsed = JSON.parse(jsonStr);
    return parsed;
  }

  // Apply answer to question
  async function applyAnswer(question, answer) {
    switch (question.type) {
      case "single":
        await applySingleAnswer(question, answer);
        break;
      case "multiple":
        await applyMultipleAnswer(question, answer);
        break;
      case "fill":
        await applyFillAnswer(question, answer);
        break;
    }
  }

  // Apply single choice answer
  async function applySingleAnswer(question, answer) {
    const answerLetter = String(answer.answer).toUpperCase();

    for (const option of question.options) {
      if (option.label === answerLetter) {
        await clickElement(option.element);
        break;
      }
    }
  }

  // Apply multiple choice answer
  async function applyMultipleAnswer(question, answer) {
    let answers = answer.answer;
    if (typeof answers === "string") {
      answers = answers.split("").filter((c) => /[A-Z]/.test(c));
    }

    for (const option of question.options) {
      if (answers.includes(option.label)) {
        await clickElement(option.element);
        await sleep(200);
      }
    }
  }

  // Apply fill-in-the-blank answer
  async function applyFillAnswer(question, answer) {
    let answers = answer.answer;
    if (!Array.isArray(answers)) {
      answers = [answers];
    }

    for (let i = 0; i < Math.min(answers.length, question.inputs.length); i++) {
      const input = question.inputs[i];
      const value = toPlainAnswerText(answers[i]);

      // Focus and fill
      input.focus();
      await sleep(100);

      // Clear existing value
      input.value = "";

      // Set new value
      input.value = value;

      // Trigger events
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));

      await sleep(100);
    }
  }

  // Click element - 增强版，兼容 React/Vue SPA
  async function clickElement(element) {
    if (!element) {
      console.warn("[AI答题助手] clickElement: element为空");
      return;
    }
    // 一个选项只触发一次 click；重复触发会把某些多选项再次取消。
    const target = element.matches?.('input[type="radio"],input[type="checkbox"]')
      ? element : element.querySelector?.('input[type="radio"],input[type="checkbox"]') || element;
    if (target.matches?.('input[type="radio"],input[type="checkbox"]') && target.checked) return;
    if (typeof target.click === 'function') target.click();
    else target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    pageTouched = true;
  }

  // Scroll to element
  function scrollToElement(element) {
    if (!element) return;
    element.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  // Highlight element - 高亮当前正在处理的题目（绿色流动光效）
  function highlightElement(element) {
    if (!element) return;

    // 保存原始样式
    element.dataset.originalOutline = element.style.outline || "";
    element.dataset.originalOutlineOffset = element.style.outlineOffset || "";
    element.dataset.originalBoxShadow = element.style.boxShadow || "";
    element.dataset.originalPosition = element.style.position || "";

    // 确保元素有定位以便添加伪元素
    if (getComputedStyle(element).position === "static") {
      element.style.position = "relative";
    }

    // 添加流动光效样式（如果还没添加）
    if (!document.getElementById("ai-answer-highlight-style")) {
      const style = document.createElement("style");
      style.id = "ai-answer-highlight-style";
      style.textContent = `
        @keyframes ai-border-flow {
          0% { background-position: 0% 50%; }
          50% { background-position: 100% 50%; }
          100% { background-position: 0% 50%; }
        }
        .ai-answer-processing {
          position: relative !important;
        }
        .ai-answer-processing::before {
          content: '';
          position: absolute;
          top: -3px;
          left: -3px;
          right: -3px;
          bottom: -3px;
          background: linear-gradient(90deg, #3b82f6, #6366f1, #8b5cf6, #6366f1, #3b82f6);
          background-size: 300% 100%;
          border-radius: 8px;
          z-index: -1;
          animation: ai-border-flow 2s ease infinite;
        }
        .ai-answer-processing::after {
          content: '';
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: white;
          border-radius: 6px;
          z-index: -1;
        }
      `;
      document.head.appendChild(style);
    }

    // 应用高亮样式
    element.style.boxShadow = "0 0 20px rgba(59, 130, 246, 0.5)";
    element.style.transition = "all 0.3s ease";
    element.style.zIndex = "1";

    // 添加动画类
    element.classList.add("ai-answer-processing");
  }

  // Remove highlight - 移除高亮
  function removeHighlight(element) {
    if (!element) return;

    // 恢复原始样式
    element.style.outline = element.dataset.originalOutline || "";
    element.style.outlineOffset = element.dataset.originalOutlineOffset || "";
    element.style.boxShadow = element.dataset.originalBoxShadow || "";
    element.style.position = element.dataset.originalPosition || "";
    element.style.zIndex = "";

    // 移除动画类
    element.classList.remove("ai-answer-processing");
  }

  // ======================== 答案详情面板（已移除） ========================

  function recordSkippedPage(marker,reason){
    skippedPages.push({marker,reason});
    sendLog('warning','已跳过（不计完成）：'+reason);
    updateStats();
  }
  // Send log to popup
  function sendLog(level, text) {
    chrome.runtime.sendMessage({ type: "log", level, text });
  }

  // Update stats in popup
  function updateStats() {
    chrome.runtime.sendMessage({
      type: "updateStats",
      ...window.CourseAnswerTools.stats(questions, submittedGroups),
      skippedCount:skippedPages.length,
    });
  }

  // Send complete message
  function sendComplete(success = false) {
    chrome.runtime.sendMessage({ type: "complete", answeredCount, success, skippedCount:skippedPages.length });
  }

  // Sleep utility
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // SPA 路由变化时清理状态
  function resetState() {
    questions = [];
    answeredCount = 0;
    aiDetectedSelectors = null;
    updateStats();
    console.log('[AI答题助手] 页面路由已变化，状态已重置');
  }

  // 测试桥接：DOM CustomEvent + postMessage 双通道
  function testTrigger(configOverride) {
    config = configOverride || { baseUrl: '', apiKey: '', model: '' };
    questions = [];
    answeredCount = 0;
    aiDetectedSelectors = null;
    console.log('[TEST] 测试触发, config:', JSON.stringify(config));
    handleScan((scanResult) => {
      if (scanResult && scanResult.success) {
        console.log('[TEST] 扫描成功, 开始答题');
        startAnswering();
      } else {
        console.log('[TEST] 扫描失败:', scanResult?.message);
      }
    });
  }
  // 暴露到 DOM 元素上，Playwright 可触发
  document.addEventListener('ai-test-start', (e) => {
    console.log('[TEST] CustomEvent收到');
    testTrigger(e.detail || {});
  });
  window.addEventListener('message', (event) => {
    if (!event.data || typeof event.data !== 'object') return;
    if (event.data.source !== 'ai-test-harness') return;
    const msg = event.data;
    if (msg.action === 'start') {
      console.log('[TEST] postMessage收到');
      testTrigger(msg.config);
    } else if (msg.action === 'logState') {
      window.postMessage({
        source: 'ai-test-harness',
        type: 'stateReport',
        payload: {
          url: window.location.href,
          ...window.CourseAnswerTools.stats(questions, submittedGroups),
          isRunning,
          templates: window.siteMatcher ? window.siteMatcher._templates?.map(t => t.siteId) : [],
        }
      }, '*');
    }
  });

  let lastUrl = window.location.href;
  window.addEventListener('hashchange', () => {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      resetState();
    }
  });
  window.addEventListener('popstate', () => {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      resetState();
    }
  });
  // 也用 MutationObserver 兜底检测 SPA 内的 URL 变化
  new MutationObserver(() => {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      resetState();
    }
  }).observe(document.body || document.documentElement, { childList: true, subtree: true });

  // Initialize
  console.log("AI自动答题助手已加载");

  // 初始化模板系统
  if (window.templateManager) {
    window.templateManager
      .init()
      .then(() => {
        console.log("模板系统初始化完成");
        // WeLearn iframe 自动触发
        if (window.welearnAPI && window.welearnAPI.isInIframe()) {
          console.log("[AI答题助手] 检测到 WeLearn iframe，自动提取答案...");
          console.log('[WE Learn] 等待用户点击开始，加载课件不自动填写或提交');
        }
      })
      .catch((error) => {
        console.error("模板系统初始化失败:", error);
      });
  }

  // WeLearn iframe 自动答题
  async function autoTriggerWelearn() {
    try {
      const wlResult = await window.welearnAPI.getAnswers();
      if (wlResult && wlResult.answers && wlResult.answers.length > 0) {
        // 构建题目列表 + 面板
        questions = [];
        const typeMap = { single: "single", blank_choice: "fill", fill: "fill" };
        let tabName = "";
        wlResult.answers.forEach((a, i) => {
          if (a.tabName && a.tabName !== tabName) tabName = a.tabName;
          questions.push({
            index: i,
            type: typeMap[a.type] || "single",
            text: (tabName ? "[" + tabName + "] " : "") + (a.questionText || ""),
            options: [],
            inputs: [],
            answered: false,
            answer: a.answers[0],
            _welearnAnswer: true,
          });
        });
        updateStats();
        // 自动点击正确选项
        const fillResult = window.welearnAPI.autoFillAnswers(wlResult.answers);
        console.log("[AI答题助手] WeLearn 自动填入:", fillResult);
        // 自动提交（无论是否填入了选项都提交）
        setTimeout(() => {
          const submitted = window.welearnAPI.clickSubmit();
          console.log("[AI答题助手] WeLearn 自动提交:", submitted);
        }, 800);
      }
    } catch (e) {
      console.error("[AI答题助手] WeLearn 自动触发失败:", e);
    }
  }
})();
