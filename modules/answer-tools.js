(() => {
 const clean=v=>String(v??'').trim();
 function bind(questions,rows){
  const fill=q=>['fill','banked_cloze','translation','rewrite_sentence','grammar_fill','fill_blank','blank','short_answer'].includes(q.type);
  const need=q=>fill(q)?Math.max(1,q.inputs?.length||0):1;
  if(!Array.isArray(rows)||rows.length!==questions.reduce((n,q)=>n+need(q),0))return {ok:false,reason:'答案条目数与作答位数不一致，保留原题等待核对'};
  let i=0;const staged=[];
  for(const q of questions){
   const group=rows.slice(i,i+need(q));i+=need(q);
   if(group.some(r=>!Array.isArray(r.answers)||!r.answers.length||r.answers.some(v=>!['string','number'].includes(typeof v))))return {ok:false,reason:'答案格式不完整'};
   const alternatives=group.map(r=>r.answers.map(clean).filter(Boolean));
   if(alternatives.some(a=>!a.length||a.every(v=>/answers? (?:may|will) vary|your own answer|答案略|答案不唯一/i.test(v))))return {ok:false,reason:'存在空答案'};
   if(fill(q))staged.push({answer:alternatives.map(a=>a[0]),alternatives});
   else if(q.type==='multiple')staged.push({answer:alternatives[0],alternatives});
   else if(alternatives[0].length===1)staged.push({answer:alternatives[0][0],alternatives});
   else return {ok:false,reason:'单选题出现多条答案，待核对题型'};
  }
  staged.forEach((x,i)=>Object.assign(questions[i],{answer:x.answer,answerAlternatives:x.alternatives,_unipusAnswer:true}));
  return {ok:true,count:questions.length};
 }
 function stats(questions,submitted=0){
  const blanks=q=>q.type==='dropdown_choice'?1:(q.inputs?.length||0);
  return {questionCount:questions.length,blankCount:questions.reduce((n,q)=>n+blanks(q),0),
   answeredCount:questions.filter(q=>q.answered).length,
   answeredBlankCount:questions.filter(q=>q.answered).reduce((n,q)=>n+blanks(q),0),submittedCount:submitted};
 }
 function sequence(sequence,raw){
  let values=raw;
  if(typeof values==='string'){try{values=JSON.parse(values)}catch{values=values.split(/[,，;\s]+/).filter(Boolean)}}
  if(!Array.isArray(values)||values.length!==sequence.slots.length)return null;
  const items=sequence.items;
  const mapped=values.map(v=>{
   const key=clean(v).replace(/[.．]$/,'');
   return items.find(o=>clean(o.label).toUpperCase()===key.toUpperCase()) ||
    items.find(o=>o.text&&clean(o.text)===key);
  });
  if(mapped.some(v=>!v)||new Set(mapped).size!==items.length||items.length!==values.length)return null;
  return mapped.map((item,i)=>({number:i+1,label:item.label,text:item.text||'图片选项 '+item.label}));
 }
 const api={bind,stats,sequence};
 if(typeof window!=='undefined')window.CourseAnswerTools=api;
 if(typeof module!=='undefined')module.exports=api;
})();
