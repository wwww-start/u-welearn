(() => {
 const shouldSkip=(status,enabled)=>!!enabled && ['manual','pending','unsupported','answer_failed','submit_failed','scan_failed'].includes(status);
 const api={shouldSkip};
 if(typeof module!=='undefined')module.exports=api;
 if(typeof window!=='undefined')window.CourseFlowPolicy=api;
})();
