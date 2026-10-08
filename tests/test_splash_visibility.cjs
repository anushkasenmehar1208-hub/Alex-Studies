const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(require('node:path').join(__dirname, '../uni_app/uni_app.py'), 'utf8');
const start=source.indexOf('(function(){\n  var CSS=');
const end=source.indexOf('\n})();',start)+'\n})();'.length;
const splash=source.slice(start,end);
function preview(framesRun) {
  let clock=0,nextId=0; const timers=new Map(),removed=[],classes=new Set();
  const element=id=>({id,style:{},classList:{add(){}},remove(){removed.push(this.id)},appendChild(){}});
  const doc={body:{appendChild(){}},head:{appendChild(){}},documentElement:{classList:{add:c=>classes.add(c)}},
    readyState:'complete',getElementById(){return null},createElement:()=>element(''),fonts:{},addEventListener(){}};
  doc.createElement=()=>element('element');
  const win={addEventListener(){}};
  const ctx=vm.createContext({document:doc,window:win,CSSStyleSheet:{prototype:{}},Date:{now:()=>clock},
    MutationObserver:class{observe(){}},Array,
    setTimeout(fn,delay){const id=++nextId;timers.set(id,{fn,at:clock+delay});return id},
    clearTimeout:id=>timers.delete(id),requestAnimationFrame:fn=>{if(framesRun)fn()}});
  vm.runInContext(splash,ctx);
  function advance(ms){const limit=clock+ms;while(true){const due=[...timers].filter(([,t])=>t.at<=limit).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;clock=due[1].at;timers.delete(due[0]);due[1].fn()}clock=limit}
  return {advance,removed,classes};
}
test('Safari suspended animation frames cannot leave the splash permanently covering the workspace',()=>{
  const p=preview(false);p.advance(12500);
  assert.ok(p.classes.has('__app_ready'));assert.ok(p.removed.includes('__uni_sp'));assert.ok(p.removed.includes('__uni_tb'));
});
test('normal animation frames retain the existing reveal path and clean the splash once',()=>{
  const p=preview(true);p.advance(12500);
  assert.equal(p.removed.filter(id=>id==='__uni_sp').length,1);
});
test('connection gate remains visible if hydration resets html readiness class',()=>{
  assert.doesNotMatch(source,/html:not\(\.__app_ready\) body\{visibility:hidden!important\}/);
});
