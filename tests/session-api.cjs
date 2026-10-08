const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
(async () => {
  let reply = { code: 0, data: JSON.stringify([{id: 1, answer: JSON.stringify({children:[{answers:['hello']}]})}]) };
  let request;
  const sandbox = {window: {}, URLSearchParams, console, fetch: async (url, options) => {
    request = {url, options}; return {ok: true, json: async () => reply};
  }};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../modules/unipus-api.js'), 'utf8'), sandbox);
  const api = sandbox.window.unipusAPI;
  assert.equal(JSON.stringify(await api.getAnswersForTask('course', 'task')), JSON.stringify([{answers:['hello'],id:1}]));
  assert.equal(request.options.credentials, 'same-origin');
  assert.equal(request.options.headers, undefined);
  reply = {code:0, data:'unipus.encrypted'};
  assert.equal(await api.getAnswersForTask('course','task'), null);
  sandbox.fetch = async () => ({ok:false,status:401});
  assert.equal(await api.getAnswersForTask('course','task'), null);
  console.log('PASS: current-session readable answers; encrypted and rejected responses fall back; no generated auth header');
})().catch(e => {console.error(e); process.exitCode=1;});
