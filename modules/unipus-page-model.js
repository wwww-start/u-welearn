// U校园实际控件模型：识别与页面分类使用同一组规则。
(() => {
  'use strict';
  const text = (el, limit = 12000) => (el?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, limit);
  function visible(el) {
    if (!el?.isConnected) return false;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const style = getComputedStyle(n);
      if (n.hidden || n.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return true;
  }
  function outline(el) {
    const copy = el.cloneNode(true);
    copy.querySelectorAll('.fe-scoop').forEach((s, i) => s.replaceWith(`[空${Number(s.getAttribute('data-scoop-index') ?? i) + 1}]`));
    copy.querySelectorAll('script,style,.component-analysis,video,audio,textarea,input,.ucomp-recorder').forEach(n => n.remove());
    return text(copy);
  }
  // Read-only candidate extraction. DOM reordering alone is not a verified answer write.
  function inspectSequence(root = document.querySelector('.pc-content-container') || document) {
    const group = root.querySelector('.sequence-view,.sortable-list-wrapper');
    if (!group) return null;
    const items = [...group.querySelectorAll('.sequence-reply-view-item-text')].filter(visible).map((el, index) => {
      const copy = el.cloneNode(true);
      const caption = copy.firstElementChild;
      const label = text(caption).replace(/[.．]$/, '').trim();
      caption?.remove();
      return {index, label, text: text(copy),
        images: [...el.querySelectorAll('img')].map(img => ({src: img.currentSrc || img.src || '', alt: img.alt || ''}))};
    });
    const slots = [...group.querySelectorAll('.sortable-list-question-no')].filter(visible).map((el, index) => ({index, text: text(el)}));
    return {type: items.some(item => item.images.length) ? 'image_matching' : 'ordering',
      items, slots, writeVerified: false,
      reason: '候选项已提取；需要验证真实拖拽控件写入，当前不自动提交'};
  }
  function reviewAnswers(root=document.querySelector('.pc-content-container')||document) {
    return [...root.querySelectorAll('.fe-scoop[data-scoop-index]')].map(scoop=>{
      const reference=scoop.querySelector('.reference-wrapper .reference');
      const right=scoop.querySelector('.input-user-answer.answer-right input');
      const value=reference?text(reference):right?.value;
      return value?{number:Number(scoop.getAttribute('data-scoop-index'))+1,label:'',text:value}:null;
    }).filter(Boolean).sort((a,b)=>a.number-b.number);
  }
  function inspect() {
    const root = document.querySelector('.pc-content-container') || document.querySelector('.pc-main-container') || document;
    const tabEl = document.querySelector('.pc-header-tasks-row .pc-header-task-activity');
    const tab = (tabEl?.getAttribute('title') || text(tabEl)).trim();
    const direction = text(root.querySelector('.abs-direction'));
    const result = (status, reason, questions = []) => ({status, reason, questions, count: questions.length, success: status === 'ready'});
    if (!root.querySelector('.question-wrap') && !document.querySelector('.pc-content-container')) return result('legacy', '使用旧版模板');
    if (/^Discussion\s*[123]$/i.test(tab) || root.querySelector('.ds-discussion-reply')) {
      return result('discussion', 'Discussion 评论页，按设置跳过（不计为答题完成）');
    }
    const context = [...root.querySelectorAll('.question-common-abs-material .text-material-wrapper')].map(outline).join('\n').slice(0, 14000);
    const questions = [];
    const add = q => questions.push({index: questions.length, options: [], inputs: [], answered: false, context, direction, ...q});
    root.querySelectorAll('.question-common-abs-choice').forEach(group => {
      if (!visible(group)) return;
      const options = [...group.querySelectorAll('.option')].filter(visible).map((el, i) => ({
        label: text(el.querySelector('.caption')) || String.fromCharCode(65 + i),
        text: text(el.querySelector('.content') || el), element: el
      }));
      if (!options.length) return;
      add({type: group.classList.contains('multipleChoice') || group.querySelector('input[type="checkbox"]') ? 'multiple' : 'single',
        text: text(group.querySelector('.ques-title')) || direction,
        options, element: group});
    });
    root.querySelectorAll('.fe-scoop[data-scoop-index]').forEach(scoop => {
      const trigger = scoop.querySelector('.scoop-select-wrapper .ant-dropdown-trigger.user-answer');
      if (!trigger || !visible(trigger)) return;
      const row = scoop.closest('tr');
      const cell = scoop.closest('td,p') || scoop.closest('.item') || scoop.parentElement;
      // 文字型下拉框把候选项放在测量宽度用的 i 节点里；字母型可从所在行提取完整选项。
      const values = [...scoop.querySelectorAll('.scoop-select-wrapper > div > i')].map(el => text(el)).filter(Boolean);
      const rowOptions = [...(row?.querySelectorAll('ol > li') || [])].map(el => text(el));
      const labelsOnly = values.length > 0 && values.every(value => /^[A-Z]$/.test(value));
      const optionTexts = rowOptions.length ? rowOptions : values;
      const options = optionTexts.map((value, i) => ({label: String.fromCharCode(65 + i), text: value,
        value: rowOptions.length || labelsOnly ? String.fromCharCode(65 + i) : value}));
      add({type: 'dropdown_choice', text: outline(cell), options, element: cell,
        dropdownElement: trigger, blankIndex: Number(scoop.getAttribute('data-scoop-index'))});
    });
    root.querySelectorAll('.question-common-abs-reply').forEach(group => {
      if (!visible(group) || group.querySelector('.question-common-abs-choice,.scoop-select-wrapper,.sequence-view,.ucomp-recorder')) return;
      const inputs = [...group.querySelectorAll('textarea,input:not([type]),input[type="text"],[contenteditable="true"]')]
        .filter(el => visible(el) && !el.disabled && !el.readOnly).map(element => ({element}));
      if (!inputs.length) return;
      const header = group.querySelector('.question-inputbox-header > .component-htmlview,.ques-title');
      add({type:'fill', text: text(header) || outline(group) || direction, inputs, element:group,
        openResponse:inputs.every(i=>i.element.tagName==='TEXTAREA') && !/\b(watch|listen|podcast|audio)\b/i.test(direction)});
    });
    if (/choose the items that you have confirmed/i.test(direction)) return result('manual', '这是个人准备情况自评，请按实际情况勾选');
    if (root.querySelector('.sequence-view,.sortable-list-wrapper')) return {...result('manual', '排序/图片配对候选项已提取，真实控件写入待验证；不计为完成'), sequence: inspectSequence(root)};
    if (root.querySelector('.ucomp-recorder,.record-button-group') && !questions.length) return result('manual', '本页为录音/跟读/配音，请完成录音后继续');
    if (questions.length) return result('ready', '', questions);
    if (root.querySelector('.component-analysis')) return result('review', '本页已显示答案解析，当前为只读回顾页');
    if (root.querySelector('.fe-scoop,.question-common-abs-reply,.question-common-abs-choice')) return result('pending', '练习控件尚未加载或暂未支持，停留本页等待检查');
    if (!text(root) || /^(Exercise|Step)\b/i.test(tab) || root.querySelector('.ant-spin-spinning')) return result('pending', '当前练习仍在加载，停留本页等待控件');
    return result('passive', '当前为阅读/视频材料页，无答题控件');
  }
  window.UnipusPageModel = { inspect, visible, inspectSequence, reviewAnswers };
})();
