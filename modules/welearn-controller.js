// WE Learn wrapper owns navigation; lesson frames only process explicit commands.
(() => {
 if(location.hostname!=='welearn.sflep.com'||window!==window.top)return;
 if(window.__welearnControllerLoaded)return;window.__welearnControllerLoaded=true;
 let running=false,cancelled=false,skipped=[],answered=0,count=0,serial=0,blanks=0,filledBlanks=0,submitted=0;
 const log=(level,text)=>chrome.runtime.sendMessage({type:'log',level,text});
 const stats=()=>chrome.runtime.sendMessage({type:'updateStats',questionCount:count,answeredCount:answered,skippedCount:skipped.length,blankCount:blanks,answeredBlankCount:filledBlanks,submittedCount:submitted});
 const wait=ms=>new Promise(r=>setTimeout(r,ms));
 const relay=message=>new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(new Error('WE Learn 课件响应超时')),3600000);
   chrome.runtime.sendMessage({action:'welearnFrameCommand',message},response=>{
     clearTimeout(timer);if(chrome.runtime.lastError)reject(new Error(chrome.runtime.lastError.message));
     else if(!response?.success)reject(new Error(response?.error||'课件连接失败'));else resolve(response.data);
   });
 });
 function entries(){
   const seen=new Set();
   return [...document.querySelectorAll('[onclick*="SelectSCO("]')].map(e=>({element:e,id:e.getAttribute('onclick').match(/SelectSCO\(['"]([^'"]+)['"]/i)?.[1]})).filter(x=>{
     if(!x.id||seen.has(x.id))return false;seen.add(x.id);return true;
   });
 }
 function current(){
   const src=document.querySelector('iframe[src*="centercourseware.sflep.com"]')?.src||'';
   return decodeURIComponent(src).match(/m-\d+-\d+-(?:\d+|intro)(?![\d])/i)?.[0]||src;
 }
 async function advance(before){
   const list=entries(),i=list.findIndex(x=>x.id===before);
   if(i<0){log('warning','目录未找到当前练习，停止而不是误报完成');return 'failed';}
   if(i===list.length-1)return 'end';
   if(cancelled)return 'failed';
   list[i+1].element.click();
   for(let n=0;n<50&&!cancelled;n++){
     await wait(200);
     if(current()===list[i+1].id){await wait(1800);return 'advanced';}
   }return 'failed';
 }
 async function run(message){
   if(running)return;
   running=true;cancelled=false;skipped=[];answered=0;count=0;blanks=0;filledBlanks=0;submitted=0;
   const token=++serial,seen=new Set();
   let reachedEnd=false,subPage='main',lastSco=null;
   const auto=!!message.autoContinue||!!message.skipUnfinished;
   try{
     if(!document.querySelector('iframe[src*="centercourseware.sflep.com"]')){
       log('warning','请先打开具体课件练习，再启动 WE Learn 自动流程');return;
     }
     while(running&&!cancelled&&token===serial){
       const id=current();
       const key=id+'|'+subPage;
       if(seen.has(key)){log('warning','检测到重复课件，停止');break;}
       seen.add(key);
       let result;
       try {result=await relay({action:'welearnProcess',config:message.config,sco:id,resetNavigation:lastSco!==id});}
       catch(e){result={status:'scan_failed',reason:e.message,answered:0,count:0};}
       if(cancelled||token!==serial)break;
       lastSco=id;
       answered+=result.answered||0;count+=result.count||0;blanks+=result.blankCount||0;filledBlanks+=result.answeredBlankCount||0;submitted+=result.submittedCount||0;stats();
       log(result.status==='completed'?'success':'info',result.reason||result.status);
       if(['auth','rate_limit'].includes(result.status)){log('error','配置或限流问题影响后续请求，已停止，未把页面记为完成');break;}
       const traversable=['completed','review','passive'].includes(result.status);
       if(!traversable){
         if(!CourseFlowPolicy.shouldSkip(result.status,message.skipUnfinished)){log('warning','已保留当前未完成页；开启“一键跳过”可继续');break;}
         skipped.push({id,page:key,reason:result.reason||result.status});stats();
         log('warning','已跳过并记录：'+id);
       }
       if(!auto)break;
       await wait(2200+Math.floor(Math.random()*1000));
       const embedded=await relay({action:'welearnAdvanceEmbedded',sco:id});
       if(embedded?.status==='advanced'){subPage=embedded.id;continue;}
       if(embedded?.status!=='end'){log('warning',embedded?.reason||'子页导航未确认，已停止');break;}
       const next=await advance(id);
       subPage='main';
       if(next==='end'){reachedEnd=true;break;}
       if(next!=='advanced'){log('warning','翻页未确认，流程停止');break;}
     }
   }finally{
     if(token!==serial)return;
     running=false;
     await chrome.storage.local.set({lastWelearnRun:{visited:[...seen],skipped,answered,count,blanks,filledBlanks,submitted,reachedEnd,time:Date.now()}});
     chrome.runtime.sendMessage({type:'complete',success:reachedEnd,answeredCount:answered,skippedCount:skipped.length});
   }
 }
 chrome.runtime.onMessage.addListener((message,sender,respond)=>{
   if(message.action==='start'){run(message);respond({success:true});return false;}
   if(message.action==='stop'){cancelled=true;running=false;serial++;chrome.runtime.sendMessage({type:'complete',success:false,answeredCount:answered,skippedCount:skipped.length});relay({action:'welearnStop'}).catch(()=>{});respond({success:true});return false;}
   if(message.action==='getStatus'){respond({isRunning:running,questionCount:count,answeredCount:answered,skippedCount:skipped.length,blankCount:blanks,answeredBlankCount:filledBlanks,submittedCount:submitted});return false;}
 });
})();
