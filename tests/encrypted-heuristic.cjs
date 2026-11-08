// 字体加密启发式测试：looksEncrypted 的判定边界
// 用法：node tests/encrypted-heuristic.cjs
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'modules', 'xuexitong-answer.js');
const src = fs.readFileSync(SRC, 'utf8');

const start = src.indexOf('function looksEncrypted');
const end = src.indexOf('function isFormulaHeavy');
if (start < 0 || end < 0) { console.log('FAIL 未找到 looksEncrypted'); process.exit(1); }

const ctx = { console };
vm.createContext(ctx);
vm.runInContext(src.slice(start, end) + '\n this.__fn = looksEncrypted;', ctx);
const looksEncrypted = ctx.__fn;

const cases = [
  ['求由摆线的一拱与x轴所围图形的面积（a>0）', false, '正常题面'],
  ['下列哪一项不属于未来人工智能发展的重要趋势？（）', false, '正常题面'],
  ['矩阵 A 可逆的充要条件是（ ）', false, '正常题面'],
  ['在“感知交互时代”（2000-2020年），机器人的主要特征是什么？()', false, '正常题面'],
  ['寙寑寗线,寚一拱()与轴所寘寜图形寚面寠( )', true, '字体加密（实测样本）'],
  ['寙寑寗', true, '纯生僻字'],
  ['', true, '空文本'],
  ['A', true, '过短'],
  ['\uE000\uE001\uE002\uE003', true, '私有区字符'],
];

let bad = 0;
for (const [text, want, note] of cases) {
  const got = looksEncrypted(text);
  const ok = got === want;
  if (!ok) bad++;
  console.log((ok ? 'PASS ' : 'FAIL ') + JSON.stringify(text.slice(0, 26)).padEnd(34) +
    ' => ' + (got ? '需截图' : '文本可用').padEnd(8) + ' (' + note + ')');
}
console.log(bad ? '\nFAIL ' + bad + ' 项' : '\nPASS 全部通过');
process.exit(bad ? 1 : 0);
