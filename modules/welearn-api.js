// WE Learn API 模块 — 数据 HTML 解析正解 + DOM 自动填入
// 优先在 iframe 内同源取数据，回退到 bg 跨域代理

(function () {
  "use strict";

  // ======================== 环境检测 ========================

  function isInIframe() {
    return (
      window.location.hostname === "centercourseware.sflep.com"
    );
  }

  // ======================== 页面信息提取 ========================

  function extractPageInfo() {
    const result = { dataUrl: null, route: null };

    if (isInIframe() && window.location.hash) {
      // iframe 内：从 hash 推导 data URL
      const hash = (window.location.hash || "").replace(/^#\/?/, "");
      const route = hash.split("?")[0];
      result.route = route;
      result.dataUrl = "data/" + route + ".html";
    } else {
      // 主页面：从 iframe src 推导（保留 %20 编码，不用 new URL 解码）
      const params = new URLSearchParams(window.location.search);
      result.cid = params.get("cid");
      result.classid = params.get("classid");
      result.tid = params.get("tid");
      result.sco = params.get("sco");

      const iframe = document.querySelector(
        'iframe[src*="centercourseware.sflep.com"]'
      );
      if (iframe) {
        try {
          const src = iframe.src;
          // src: "https://centercourseware.sflep.com/New%20Advanced.../index.html#/10/4-1"
          // 直接字符串替换，不经过 URL 解码
          const hashPart = (src.split("#")[1] || "").replace(/^\//, "");
          const route = hashPart.split("?")[0];
          const baseUrl = src.replace(/\/index\.html.*$/, "");
          result.route = route;
          result.dataUrl = baseUrl + "/data/" + route + ".html";
        } catch (_) {}
      }
    }

    return result;
  }

  // ======================== 数据 HTML 抓取 ========================

  async function fetchDataHtml(url) {
    if (isInIframe()) {
      // iframe 内同源，直接 fetch
      console.log("[welearn-api] iframe 同源抓取:", url);
      const resp = await fetch(url);
      if (!resp.ok) throw new Error("Fetch failed: " + resp.status);
      return await resp.text();
    } else {
      // 主页面跨域，通过 bg 代理
      console.log("[welearn-api] 主页面 bg 代理抓取:", url);
      return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          { action: "fetchWelearnData", url },
          (response) => {
            if (chrome.runtime.lastError)
              return reject(new Error(chrome.runtime.lastError.message));
            if (!response.success) return reject(new Error(response.error));
            resolve(response.data);
          }
        );
      });
    }
  }

  // ======================== HTML 答案解析 ========================

  function parseAnswers(html) {
    const results = [];
    let currentTabName = "";

    // 提取 Tab 标题
    const tabTitles = [];
    const headerMatch = html.match(/<ul header>([\s\S]*?)<\/ul>/);
    if (headerMatch) {
      const liMatches = headerMatch[1].matchAll(
        /<li[^>]*>([^<]*)<\/li>/g
      );
      for (const m of liMatches) tabTitles.push(m[1].trim());
    }

    const tabSections = html.split(/(<tab>|<\/tab>)/);
    let tabIdx = -1;
    let inTab = false;

    for (const section of tabSections) {
      if (section === "<tab>") {
        inTab = true;
        tabIdx++;
        currentTabName = tabTitles[tabIdx] || "Tab " + (tabIdx + 1);
        continue;
      }
      if (section === "</tab>") {
        inTab = false;
        continue;
      }
      if (!inTab || !section.trim()) continue;

      const dirMatch = section.match(
        /<et-direction[^>]*>([\s\S]*?)<\/et-direction>/
      );
      const direction = dirMatch
        ? dirMatch[1].replace(/<[^>]+>/g, "").trim()
        : "";

      // et-choice：选择题 / 选词填空
      const choiceRegex =
        /<et-choice\s+([^>]*?)>([\s\S]*?)<\/et-choice>/g;
      let cm;
      while ((cm = choiceRegex.exec(section)) !== null) {
        const attrs = cm[1];
        const inner = cm[2];
        const keyMatch = attrs.match(/key\s*=\s*"([^"]*)"/);
        if (!keyMatch) continue;

        const key = keyMatch[1];
        const hasJoin = /join\s*=/.test(attrs);
        let answer, type;

        if (hasJoin) {
          // 选词填空：key 数字 → span 索引
          type = "blank_choice";
          const spans = [];
          const sr = /<span[^>]*>([^<]*)<\/span>/g;
          let sm;
          while ((sm = sr.exec(inner)) !== null)
            spans.push(sm[1].trim());
          answer = spans[parseInt(key) - 1] || key;
        } else {
          // 选择题：key 字母 → 选项索引
          type = "single";
          const opts = [];
          const lr = /<li[^>]*>([\s\S]*?)<\/li>/g;
          let lm;
          while ((lm = lr.exec(inner)) !== null)
            opts.push(lm[1].replace(/<[^>]+>/g, "").trim());
          const idx = key.toUpperCase().charCodeAt(0) - 65;
          answer = opts[idx] || key.toUpperCase();
        }

        const idxMatch = attrs.match(/index\s*=\s*"([^"]*)"/);
        results.push({
          answers: [answer],
          type: type,
          key: key,
          questionText: direction,
          tabName: currentTabName,
          questionIndex: idxMatch ? parseInt(idxMatch[1]) : null,
        });
      }

      // et-blank：填空（有/无属性均匹配，支持 | 分隔的多答案）
      const blankRegex =
        /<et-blank(?:\s+[^>]*)?>([\s\S]*?)<\/et-blank>/g;
      let bm;
      while ((bm = blankRegex.exec(section)) !== null) {
        const raw = bm[1].replace(/<[^>]+>/g, "").trim();
        if (raw) {
          results.push({
            answers: raw.split("|").map((s) => s.trim()).filter(Boolean),
            type: "fill",
            questionText: direction,
            tabName: currentTabName,
          });
        }
      }

      // et-tof：判断题 True/False
      const tofRegex = /<et-tof\s+([^>]*?)>/g;
      let tm;
      while ((tm = tofRegex.exec(section)) !== null) {
        const attrs = tm[1];
        const keyMatch = attrs.match(/key\s*=\s*"([TF])"/i);
        if (!keyMatch) continue;
        const key = keyMatch[1].toUpperCase();
        results.push({
          answers: [key === "T" ? "True" : "False"],
          type: "tof",
          key: key,
          questionText: direction,
          tabName: currentTabName,
        });
      }
    }

    return results;
  }

  // ======================== DOM 自动填入 ========================

  /**
   * 在 iframe 内自动点击正确答案
   */
  function autoFillAnswers(answerList) {
    if (!isInIframe()) {
      console.log("[welearn-api] 不在 iframe 中，跳过 DOM 自动填入");
      return { skipped: true, reason: "not in iframe" };
    }

    const results = [];
    let choiceIdx = 0;
    let blankIdx = 0;
    let tofIdx = 0;

    // 收集选择题的 ol 列表
    const stems = document.querySelectorAll("et-stem");
    const allChoiceOLs = [];
    const allBlankInputs = [];
    const allTofs = [];

    stems.forEach((stem) => {
      // 选择题选项列表
      stem.querySelectorAll("et-choice").forEach((choice) => {
        const ol = choice.querySelector("ol");
        if (ol && ol.querySelectorAll("li").length >= 2) {
          allChoiceOLs.push(ol);
        } else {
          const spans = choice.querySelectorAll("span");
          if (spans.length >= 2) {
            allChoiceOLs.push(spans);
          }
        }
      });
      // 填空输入框
      stem.querySelectorAll("et-blank").forEach((blank) => {
        const input =
          blank.querySelector("input") ||
          blank.querySelector("textarea") ||
          blank.querySelector("[contenteditable]");
        if (input) allBlankInputs.push(input);
      });
      // 判断题 et-tof 元素
      stem.querySelectorAll("et-tof").forEach((tof) => {
        const spans = tof.querySelectorAll(".controls span");
        if (spans.length >= 2) {
          allTofs.push({ el: tof, tSpan: spans[0], fSpan: spans[1] });
        }
      });
    });

    console.log(
      "[welearn-api] 找到",
      allChoiceOLs.length,
      "组选项,",
      allBlankInputs.length,
      "个填空,",
      allTofs.length,
      "个判断题"
    );

    answerList.forEach((a, i) => {
      try {
        if (a.type === "single") {
          if (choiceIdx >= allChoiceOLs.length) return;
          const ol = allChoiceOLs[choiceIdx];
          const idx = a.key.toUpperCase().charCodeAt(0) - 65;

          if (ol instanceof NodeList || Array.isArray(ol)) {
            // span 列表（错误归类为 single 的选词填空）
            if (idx >= 0 && idx < ol.length) {
              ol[idx].click();
              results.push({ i, type: "span_click", idx, ok: true });
            }
          } else {
            const lis = ol.querySelectorAll("li");
            if (idx >= 0 && idx < lis.length) {
              lis[idx].click();
              results.push({ i, type: "li_click", idx, ok: true });
            }
          }
          choiceIdx++;
        } else if (a.type === "blank_choice") {
          if (choiceIdx >= allChoiceOLs.length) return;
          const spans = allChoiceOLs[choiceIdx];
          const idx = parseInt(a.key) - 1;

          if (
            spans instanceof NodeList ||
            Array.isArray(spans) ||
            spans instanceof HTMLCollection
          ) {
            const arr = Array.from(spans);
            if (idx >= 0 && idx < arr.length) {
              arr[idx].click();
              results.push({ i, type: "span_click", idx, ok: true });
            }
          }
          choiceIdx++;
        } else if (a.type === "fill") {
          if (blankIdx >= allBlankInputs.length) return;
          const input = allBlankInputs[blankIdx];
          const val = a.answers[0];
          if (!input) { blankIdx++; return; }
          const tag = input.tagName;
          if (tag === "INPUT" || tag === "TEXTAREA") {
            const nativeSetter =
              tag === "TEXTAREA"
                ? Object.getOwnPropertyDescriptor(
                    window.HTMLTextAreaElement.prototype, "value"
                  ).set
                : Object.getOwnPropertyDescriptor(
                    window.HTMLInputElement.prototype, "value"
                  ).set;
            nativeSetter.call(input, val);
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(new Event("change", { bubbles: true }));
            results.push({ i, type: "fill", val, ok: true });
          } else if (input.isContentEditable) {
            // contenteditable span/div
            input.textContent = val;
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(new Event("change", { bubbles: true }));
            input.dispatchEvent(new Event("blur", { bubbles: true }));
            results.push({ i, type: "fill_editable", val, ok: true });
          }
          blankIdx++;
        } else if (a.type === "tof") {
          if (tofIdx >= allTofs.length) return;
          const tof = allTofs[tofIdx];
          const targetSpan = a.key === "T" ? tof.tSpan : tof.fSpan;
          if (targetSpan) {
            targetSpan.click();
            results.push({ i, type: "tof_click", key: a.key, ok: true });
          }
          tofIdx++;
        }
      } catch (e) {
        results.push({ i, error: e.message });
      }
    });

    return {
      total: answerList.length,
      clicked: results.filter((r) => r.ok).length,
      details: results,
    };
  }

  // ======================== 一站式接口 ========================

  async function getAnswers() {
    const info = extractPageInfo();

    if (!info.dataUrl) {
      console.error("[welearn-api] 无法推导数据 HTML URL");
      return null;
    }

    console.log("[welearn-api] 数据URL:", info.dataUrl);

    const html = await fetchDataHtml(info.dataUrl);
    if (!html) {
      console.error("[welearn-api] 抓取数据 HTML 失败");
      return null;
    }

    const answers = parseAnswers(html);
    console.log(
      "[welearn-api] 解析到",
      answers.length,
      "个答案:",
      answers.map((a) => a.type + ":" + (a.answers[0] || "").substring(0, 20)).join(", ")
    );

    return { info, answers };
  }

  // ======================== 导出 ========================

  window.welearnAPI = {
    isInIframe,
    extractPageInfo,
    fetchDataHtml,
    parseAnswers,
    autoFillAnswers,
    getAnswers,
  };

  console.log("[welearn-api] 模块已加载, iframe:", isInIframe());
})();


// WE Learn 1.4 adapter: legacy data-itemtype + modern et controls, no load-time answering.
(() => {
  const api = window.welearnAPI;
  const text = e => (e?.textContent || '').replace(/\s+/g,' ').trim();
  const visible = e => {
    if(!e?.isConnected)return false;
    for(let n=e;n&&n.nodeType===1;n=n.parentElement){
      const st=getComputedStyle(n);
      if(n.hidden||n.getAttribute('aria-hidden')==='true'||st.display==='none'||st.visibility==='hidden')return false;
      if(n.tagName==='LI' && n.parentElement?.parentElement?.matches('[data-controltype=embeddedpagecontrol]')){
        const a=n.getBoundingClientRect(),b=n.parentElement.parentElement.getBoundingClientRect();
        if(a.width>0&&b.width>0&&(a.right<=b.left+1||a.left>=b.right-1))return false;
      }
    }return true;
  };
  const editable = e => visible(e) && !e.disabled && !e.readOnly;
  const plain = value => {
    const d = new DOMParser().parseFromString(String(value ?? '').replace(/<br\s*\/?>/gi,'\n'),'text/html');
    d.querySelectorAll('script,style,iframe').forEach(e=>e.remove());
    return (d.body.textContent || '').trim();
  };
  const variable = s => /answers?\s+(?:may\s+vary|will\s+vary)|your\s+own\s+answer|sample\s+answer|答案不唯一/i.test(s);
  function solution(e) {
    const s=e.getAttribute('data-solution');
    return s && !variable(s) ? plain(s.split('|')[0]) : null;
  }
  function activeRoot() {
    const id=decodeURIComponent(location.search).match(/m-\d+-\d+-(?:\d+|intro)(?![\d])/i)?.[0];
    return id ? [...document.querySelectorAll('[data-controltype=page][data-scoid]')].find(e=>e.getAttribute('data-scoid')===id)||document : document;
  }
  let embeddedSeen=new Set();
  function resetEmbedded(){embeddedSeen=new Set();}
  function embeddedTargets() {
    const scope=activeRoot(),out=[],seen=new Set();
    for(const e of scope.querySelectorAll('[data-controltype=gotoembeddedpage][data-refids]')){
      for(const id of e.getAttribute('data-refids').split('|')){
        const target=[...scope.querySelectorAll('[data-controltype=embeddedpagecontrol] > ul > li[data-id]')].find(p=>p.getAttribute('data-id')===id);
        if(target&&!seen.has(id)){out.push({id,element:e,target});seen.add(id);}
      }
    }
    return out;
  }
  async function advanceEmbedded({cancelled=()=>false}={}) {
    const scope=activeRoot();
    for(const node of scope.querySelectorAll('[data-controltype=embeddedpagecontrol] > ul > li[data-id]')){
      const box=node.getBoundingClientRect(),parent=node.parentElement.parentElement.getBoundingClientRect();
      if(visible(node)&&box.width>0&&parent.width>0&&box.left<parent.right&&box.right>parent.left)
        embeddedSeen.add(node.getAttribute('data-id'));
    }
    const next=embeddedTargets().find(x=>!embeddedSeen.has(x.id));
    if(!next)return {status:'end'};
    if(cancelled())return {status:'failed',reason:'用户已停止'};
    next.element.click();
    let last='',stable=0;
    for(let i=0;i<40&&!cancelled();i++){
      await new Promise(r=>setTimeout(r,200));
      const value=text(next.target);
      if(visible(next.target)&&value){
        stable=value===last?stable+1:0;last=value;
        if(stable>=2){embeddedSeen.add(next.id);return {status:'advanced',id:next.id};}
      }
    }
    return {status:'failed',reason:'内嵌子页尚未确认加载：'+next.id};
  }
  function marker() { return location.href; }
  function inspectPage() {
    const scope=activeRoot();
    const questions=[], covered=new Set();
    const direction=text(scope.querySelector('et-direction,[data-itemtype=direction],.direction,.directions'));
    const context=text(scope).slice(0,16000);
    const transcript=[...scope.querySelectorAll('.transcript,#script_content,[data-itemtype=script]')].map(text).join('\n').slice(0,10000);
    const add = q=>questions.push({index:questions.length,text:direction||text(q.element?.parentElement).slice(0,2500),
      direction,context,transcript,options:[],inputs:[],answered:false,answer:null,...q});
    let readonly=0, unsupported=false;
    scope.querySelectorAll('ul[data-itemtype=options],et-stem et-choice,et-stem et-tof').forEach(group=>{
      if(!visible(group)) return;
      let targets=[...group.querySelectorAll(':scope > li')];
      if(group.tagName.toLowerCase()==='et-choice') targets=[...group.querySelectorAll(group.hasAttribute('join')?'span':'ol > li')];
      if(group.tagName.toLowerCase()==='et-tof') targets=[...group.querySelectorAll('.controls span')];
      if(targets.length<2){unsupported=true;return;}
      const selected=targets.filter(e=>e.hasAttribute('data-solution'));
      const multiple=group.getAttribute('data-multiple')==='true'||group.getAttribute('data-selecttype')==='multiple'||!!group.querySelector('input[type=checkbox]')||selected.length>1;
      const options=targets.map((element,i)=>({label:String.fromCharCode(65+i),text:text(element).replace(/^[A-Z][).]\s*/,''),element}));
      let key=group.getAttribute('key');
      let answer=selected.length ? selected.map(e=>options.find(o=>o.element===e).label) : null;
      if(key) answer=group.hasAttribute('join') ? options[Number(key)-1]?.label : (/^[A-Z]$/i.test(key)?key.toUpperCase():null);
      if(!multiple && Array.isArray(answer)) answer=answer[0];
      add({type:multiple?'multiple':'single',options,element:group,answer});
    });
    scope.querySelectorAll('input[data-itemtype=input],textarea[data-itemtype=textarea],et-blank input,et-blank textarea,et-blank [contenteditable=true]').forEach(e=>{
      if(covered.has(e)||!visible(e)) return;
      covered.add(e);
      if(!editable(e)){readonly++;return;}
      add({type:'fill',inputs:[{element:e}],element:e,answer:solution(e),_welearnField:true});
    });
    scope.querySelectorAll('select[data-itemtype],select[data-solution],et-stem select').forEach(e=>{
      if(!editable(e)||e.closest('.video-js,.vjs-modal-dialog'))return;
      const options=[...e.options].filter(o=>o.value!=='').map((o,i)=>({label:String.fromCharCode(65+i),text:o.textContent,value:o.value,element:o}));
      if(!options.length){unsupported=true;return;}
      add({type:'dropdown_choice',options,element:e,dropdownElement:e,answer:solution(e),_welearnSelect:true});
    });
    if(scope.querySelector('[data-itemtype=myresult],[draggable=true],et-match,et-record'))unsupported=true;
    const result=(status,reason)=>({status,reason,questions,count:questions.length,success:status==='ready',marker:marker(),unsupported});
    if(questions.length)return result('ready',unsupported?'部分控件需手动操作，未完成部分单独记录':'');
    if(readonly)return result('review','已显示答案或控件只读，不重复填写');
    if(unsupported||scope.querySelector('[data-itemtype=playmediaexcontroller],.record-button,.recorder'))return result('manual','录音、拖拽或配对控件需手动完成');
    if(!text(scope))return result('pending','页面尚未加载');
    return result('passive','阅读或音视频材料页，无可填写题目');
  }
  function selected(e) {
    return e.matches('[aria-checked=true],[aria-selected=true],[data-checked=true],.selected,.active,.checked,.current,.is-selected') ||
      !!e.querySelector('input:checked') || e.getAttribute('data-useranswer')==='true';
  }
  async function apply(q,value) {
    if(q._welearnSelect){
      const raw=plain(Array.isArray(value)?value[0]:value);
      const opt=q.options.find(o=>[o.label,o.value,o.text].some(v=>plain(v).toLowerCase()===raw.toLowerCase()));
      if(!opt||!editable(q.element))return false;
      const setter=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;
      setter.call(q.element,opt.value);q._touched=true;
      q.element.dispatchEvent(new Event('input',{bubbles:true}));q.element.dispatchEvent(new Event('change',{bubbles:true}));
      return q.element.value===opt.value;
    }
    if(q.type==='fill'){
      const vals=Array.isArray(value)?value:[value];
      if(vals.length!==q.inputs.length)return false;
      for(let i=0;i<vals.length;i++){
        const e=q.inputs[i].element,v=plain(vals[i]);if(!v||!editable(e))return false;
        if(e.isContentEditable)e.textContent=v;
        else Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,v);
        q._touched=true;e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));e.dispatchEvent(new Event('blur',{bubbles:true}));
        if((e.isContentEditable?e.textContent:e.value)!==v)return false;
      }return true;
    }
    const values=(Array.isArray(value)?value:[value]).map(v=>plain(v).toLowerCase());
    const choices=values.map(v=>q.options.find(o=>[o.label,o.text].some(s=>plain(s).toLowerCase()===v)));
    if(!choices.length||choices.some(o=>!o))return false;
    for(const o of q.options){
      const needed=choices.includes(o);
      if((q.type==='multiple'&&selected(o.element)!==needed)||(q.type==='single'&&needed&&!selected(o.element))){o.element.click();q._touched=true;}
    }
    await new Promise(r=>setTimeout(r,180));
    return q.options.every(o=>q.type==='multiple'?selected(o.element)===choices.includes(o):!choices.includes(o)||selected(o.element));
  }
  function validatePage() {
    const p=inspectPage();
    return p.questions.length>0 && !p.unsupported && p.questions.every(q=>{
      if(q.type==='fill')return q.inputs.every(i=>String(i.element.value||i.element.textContent||'').trim());
      if(q._welearnSelect)return !!q.element.value;
      return q.options.some(o=>selected(o.element));
    });
  }
  async function clickSubmit({allowPartial=false,cancelled=()=>false}={}) {
    if(cancelled()||(!allowPartial&&!validatePage()))return false;
    const scope=activeRoot();
    const button=[...scope.querySelectorAll('[data-controltype=submit],button,a,[role=button]')].find(e=>visible(e)&&!e.disabled&&
      (e.getAttribute('data-controltype')==='submit'||/^(submit|提交)$/i.test(text(e))));
    if(!button)return false;
    button.click();
    for(let i=0;i<40;i++){
      if(cancelled())return false;
      const modal=document.querySelector('[role=dialog],.modal.in,.modal.show,.ui-dialog');
      const confirm=modal&&[...modal.querySelectorAll('button,a')].find(e=>visible(e)&&/^(确定|确认|提交|OK|Confirm)$/i.test(text(e)));
      if(confirm)confirm.click();
      const fail=[...document.querySelectorAll('[role=alert],.alert-danger')].find(e=>visible(e)&&/error|失败|频繁|未填写/i.test(text(e)));
      if(fail)return false;
      const ack=[...scope.querySelectorAll('[data-controltype=mirrorcmd],[data-itemtype=result],.alert-success')].some(e=>visible(e)&&(/check|检查/i.test(text(e))||text(e)&&e.hasAttribute('data-itemtype')));
      if(ack&&!visible(button))return true;
      await new Promise(r=>setTimeout(r,200));
    }return false;
  }
  Object.assign(api,{inspectPage,apply,validatePage,clickSubmit,marker,activeRoot,embeddedTargets,advanceEmbedded,resetEmbedded,plainText:plain});
})();
