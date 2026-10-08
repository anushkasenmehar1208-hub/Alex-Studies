const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(require('node:path').join(__dirname, '../assets/alex_avatar.js'), 'utf8');
const helper = source.slice(source.indexOf('  function createAvatarMotion('), source.indexOf('  // ── Config'));
function setup() {
  let seed = 42;
  const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const names = ['eye_close', 'eye closed.L', 'eye closed.R', 'eyesLookUp', 'AH', 'OH', 'CH'];
  const face = {morphTargetDictionary: Object.fromEntries(names.map((n, i) => [n, i])), morphTargetInfluences: names.map(() => 0)};
  const keys = ['head', 'neck', 'spine', 'spine1', 'leftShoulder', 'rightShoulder', 'leftArm', 'rightArm', 'leftForeArm', 'rightForeArm', 'leftHand', 'rightHand'];
  const bones = Object.fromEntries(keys.map(k => [k, {rotation:{x:0,y:0,z:0}}]));
  const rig = {morphMeshes:[face], bones, head:bones.head, rest:Object.fromEntries(keys.map(k => [k,{x:0,y:0,z:0}])), root:{position:{y:3}}, restY:3};
  const ctx = vm.createContext({Math}); vm.runInContext(helper, ctx);
  const motion = ctx.createAvatarMotion(rig, random);
  const weight = name => face.morphTargetInfluences[face.morphTargetDictionary[name]];
  return {motion, rig, weight, tick: seconds => {for(let i=0;i<seconds/0.025;i++) motion.update(0.025,0);}};
}
test('randomized blink windows are bounded, varied, and use only the combined blink', () => {
  const b=setup(), intervals=[]; let next=b.motion.snapshot().nextBlink, sawBlink=false;
  for(let i=0;i<1600;i++) {
    b.motion.update(0.025,0);
    const s=b.motion.snapshot();
    if(s.nextBlink!==next) { intervals.push(s.nextBlink-s.time); next=s.nextBlink; assert.ok(s.blinkDuration>=0.1 && s.blinkDuration<=0.18); }
    sawBlink ||= b.weight('eye_close')>0;
    assert.equal(b.weight('eye closed.L'),0); assert.equal(b.weight('eye closed.R'),0);
  }
  assert.ok(sawBlink); assert.ok(intervals.length>5);
  assert.ok(intervals.every(n => (n>=3 && n<=7) || (n>=0.22 && n<=0.30)));
  assert.ok(new Set(intervals.map(n=>n.toFixed(2))).size>4);
});
for(const stop of ['speech-end','speech-cancel','interrupted']) test(`mouth closes immediately on ${stop}`, () => {
  const b=setup(); b.motion.speech({type:'speech-start'});
  let moved=false; for(let i=0;i<60;i++) {b.motion.update(0.025,0); moved ||= ['AH','OH','CH'].some(n=>b.weight(n)>0);}
  assert.ok(moved); b.motion.speech({type:stop});
  for(const name of ['AH','OH','CH']) assert.equal(b.weight(name),0);
  b.tick(1); for(const name of ['AH','OH','CH']) assert.equal(b.weight(name),0);
});
test('boundary envelopes use actual mouth shapes, include pauses and return to listening', () => {
  const b=setup(); b.motion.speech({type:'speech-start'}); b.motion.speech({type:'speech-boundary',word:'you'}); b.tick(0.05);
  assert.ok(b.weight('OH')>0); assert.equal(b.weight('AH'),0);
  b.motion.speech({type:'speech-boundary',word:'stop.'}); b.tick(0.3);
  assert.equal(b.weight('CH'),0);
  b.motion.speech({type:'state',state:'listening'}); assert.equal(b.motion.snapshot().state,'listening'); assert.equal(b.weight('OH'),0);
});
test('poses stay subtle without root bob and stop changing after idempotent cleanup', () => {
  const b=setup();
  for(const state of ['idle','listening','thinking','speaking','interrupted']) {
    b.motion.setState(state); b.tick(10);
    assert.equal(b.rig.root.position.y,3);
    assert.ok(Math.abs(b.rig.head.rotation.y)<0.035);
    assert.ok(Math.abs(b.rig.head.rotation.z)<0.035);
    assert.equal(b.rig.bones.leftForeArm.rotation.x,0);
  }
  b.motion.dispose(); b.motion.dispose(); const time=b.motion.snapshot().time, pose=JSON.stringify(b.rig);
  b.motion.speech({type:'speech-start'}); b.tick(10);
  assert.equal(b.motion.snapshot().time,time); assert.equal(JSON.stringify(b.rig),pose);
  assert.doesNotMatch(helper,/setTimeout|setInterval|requestAnimationFrame/);
});
