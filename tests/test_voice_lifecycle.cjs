const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../assets/alex_voice.js'), 'utf8');
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}

// Run the entire production controller, with virtual time and browser/device doubles.
// No microphone, network, provider keys, or private application state are needed.
function browser(options = {}) {
  let now = 1000, nextTimer = 1, energy = 0;
  const timers = new Map(), calls = [], recorders = [], streams = [], spoken = [], contexts = [], stopEvents = [];
  const windowListeners = new Map(), documentListeners = new Map(), observers = [];
  const intro = deferred();
  let cancelled = 0;
  function element(id) {
    const listeners = new Map();
    return {
      id, listeners, isConnected: true, disabled: false, value: '', textContent: '', innerHTML: '',
      style: {}, classList: {add() {}, remove() {}}, children: [],
      setAttribute() {}, removeAttribute() {},
      addEventListener(type, handler) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(handler); },
      removeEventListener(type, handler) { listeners.set(type, (listeners.get(type) || []).filter(fn => fn !== handler)); },
      emit(type, event = {}) { for (const handler of [...(listeners.get(type) || [])]) handler(event); },
      appendChild(child) { this.children.push(child); },
      removeChild(child) { this.children.splice(this.children.indexOf(child), 1); },
      get firstElementChild() { return this.children[0]; },
      get scrollHeight() { return this.children.length * 100; },
      scrollTop: 0,
      remove() { this.isConnected = false; },
    };
  }
  const ids = ['alex-btn', 'alex-status', 'alex-orb', 'alex-transcript', 'alex-type-row',
    'alex-type-input', 'alex-type-send', 'alex-mic-toggle', 'alex-chat-panel', 'alex-mobile-chat-panel'];
  const elements = Object.fromEntries(ids.map(id => [id, element(id)]));
  function timer(fn, ms, interval = false) {
    const id = nextTimer++;
    timers.set(id, {fn, due: now + ms, interval: interval ? ms : 0});
    return id;
  }
  function stream() {
    const track = {kind: 'audio', enabled: true, readyState: 'live',
      stop() { this.readyState = 'ended'; this.enabled = false; }};
    const value = {track, getTracks: () => [track], getAudioTracks: () => [track]};
    streams.push(value);
    return value;
  }
  class Recorder {
    static isTypeSupported(mime) { return mime === 'audio/mp4'; }
    constructor(media, opts) { this.stream = media; this.mimeType = opts.mimeType; this.state = 'inactive'; recorders.push(this); }
    start() {
      if (options.startFailure) { options.startFailure = false; throw new Error('Recorder starting failed'); }
      this.state = 'recording';
    }
    stop() {
      this.state = 'inactive';
      const deliver = () => {
        this.ondataavailable?.({data: new Blob([new Uint8Array(128)], {type: this.mimeType})});
        this.onstop?.();
      };
      if (options.delayedStop) stopEvents.push(deliver); else queueMicrotask(deliver);
    }
  }
  class AudioContext {
    constructor() { this.state = options.suspended ? 'suspended' : 'running'; contexts.push(this); }
    resume() { calls.push({kind: 'resume'}); return options.suspended ? new Promise(() => {}) : Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
    createMediaStreamSource() { return {connect() {}}; }
    createAnalyser() { return {fftSize: 512, getByteTimeDomainData(array) { array.fill(128 + energy); }}; }
  }
  const window = {
    AudioContext, MediaRecorder: Recorder, innerWidth: 1280, location: {pathname: '/s/home'},
    ALEX_VOICE_ALLOWED: true, ALEX_VOICE_SHOW_UPSELL: false, ALEX_VOICE_KEY: 'test-session',
    ALEX_AUTH_STORAGE_KEY: '_auth_token',
    addEventListener(type, fn) { windowListeners.set(type, fn); },
    removeEventListener(type, fn) { if (windowListeners.get(type) === fn) windowListeners.delete(type); },
    speechSynthesis: {resume() {}, getVoices: () => [],
      speak(utterance) { spoken.push(utterance); }, cancel() { cancelled++; }},
    SpeechSynthesisUtterance: function (text) { this.text = text; },
    MutationObserver: class {
      constructor(fn) { this.fn = fn; observers.push(this); }
      observe() {} disconnect() { this.disconnected = true; }
    },
  };
  const document = {
    documentElement: {lang: 'en'}, hidden: false,
    getElementById: id => elements[id]?.isConnected ? elements[id] : null,
    createElement: () => element('generated'),
    addEventListener(type, fn) { documentListeners.set(type, fn); },
    removeEventListener(type, fn) { if (documentListeners.get(type) === fn) documentListeners.delete(type); },
  };
  const json = body => ({ok: true, headers: {get: () => 'application/json'}, json: async () => body});
  async function fetch(url, init = {}) {
    calls.push({kind: 'fetch', url, init, at: now});
    if (url.includes('voice-intro')) return intro.promise;
    if (url.includes('voice-sync')) return json({ok: true});
    if (url.includes('voice-stt')) return options.stt ? options.stt.promise : json({text: 'Explain photosynthesis'});
    if (options.reply) return options.reply.promise;
    const payload = 'data: ' + JSON.stringify({type: 'done', tts_mode: 'browser',
      text: 'Plants use light to turn water and carbon dioxide into sugar.', voice_language: 'English'}) + '\n\n';
    return new Response(payload, {headers: {'content-type': 'text/event-stream'}});
  }
  const context = vm.createContext({window, document, navigator: {mediaDevices: {
    getUserMedia() {
      calls.push({kind: 'microphone'});
      if (options.permissionDenied) return Promise.reject({name: 'NotAllowedError'});
      return options.permission ? options.permission.promise : Promise.resolve(stream());
    },
  }}, location: {port: '', protocol: 'https:', hostname: 'example.test'},
  localStorage: {getItem: () => '"test-token"', setItem() {}},
  console: {log() {}, warn() {}, error() {}}, Blob, Response, TextDecoder, Uint8Array,
  MediaRecorder: Recorder, AbortController, Promise, fetch,
  Date: class extends Date { static now() { return now; } },
  Audio: function () { this.play = () => Promise.resolve(); this.pause = () => {}; this.removeAttribute = () => {}; this.load = () => {}; },
  setTimeout: (fn, ms) => timer(fn, ms), clearTimeout: id => timers.delete(id),
  setInterval: (fn, ms) => timer(fn, ms, true), clearInterval: id => timers.delete(id),
  });
  vm.runInContext(source, context);
  async function advance(ms) {
    const until = now + ms;
    while (true) {
      const next = [...timers.entries()].filter(([, t]) => t.due <= until).sort((a, b) => a[1].due - b[1].due)[0];
      if (!next) break;
      const [id, t] = next;
      now = t.due;
      if (t.interval) t.due += t.interval;
      else timers.delete(id);
      t.fn();
      await flush();
    }
    now = until;
    await flush();
  }
  return {window, context, elements, calls, recorders, streams, spoken, contexts, timers, intro,
    json, stream, advance, energy: value => { energy = value; },
    status: () => elements['alex-status'].textContent,
    start: async () => { const started = window.toggleAlexVoice(); await flush(); await started; await flush(); },
    event: type => windowListeners.get(type)?.(),
    removePanel() { elements['alex-btn'].isConnected = false; observers.filter(o => !o.disconnected).forEach(o => o.fn()); },
    reloadController() { vm.runInContext(source, context); },
    cancelled: () => cancelled,
    completeStops: async () => { while (stopEvents.length) stopEvents.shift()(); await flush(); },
    sttCalls: () => calls.filter(call => call.url?.includes('voice-stt')),
  };
}

test('Start Call immediately requests the microphone, then listens automatically without Unmute', async () => {
  const b = browser();
  const started = b.window.toggleAlexVoice();
  assert.equal(b.calls.findIndex(c => c.kind === 'resume'), 0);
  assert.equal(b.calls.filter(c => c.kind === 'microphone').length, 1);
  await started; await flush();
  assert.equal(b.status(), 'Listening…');
  assert.equal(b.elements['alex-mic-toggle'].textContent, 'Mute mic');
  assert.equal(b.recorders.at(-1).state, 'recording');
  assert.equal(b.streams[0].track.enabled, true);
  b.window.stopAlexVoiceSession();
});

test('brief noise does not arm silence submission; natural pauses reset the 425 ms silence window', async () => {
  const b = browser(); await b.start();
  b.energy(35); await b.advance(100); b.energy(0); await b.advance(1000);
  assert.equal(b.sttCalls().length, 0);
  b.energy(35); await b.advance(300); b.energy(0); await b.advance(300);
  assert.equal(b.sttCalls().length, 0);
  b.energy(35); await b.advance(50); b.energy(0); await b.advance(425);
  assert.equal(b.sttCalls().length, 0);
  await b.advance(25);
  assert.equal(b.sttCalls().length, 1);
  assert.equal(b.sttCalls()[0].init.body.type, 'audio/mp4');
  b.window.stopAlexVoiceSession();
});

test('two speech/STT/reply/browser-TTS turns work without touching controls, with capture paused during replies', async () => {
  const b = browser(); await b.start();
  for (let turn = 1; turn <= 2; turn++) {
    b.energy(35); await b.advance(300); b.energy(0); await b.advance(450); await flush();
    assert.equal(b.sttCalls().length, turn);
    assert.equal(b.spoken.length, turn);
    assert.equal(b.status(), 'Alex is speaking...');
    assert.equal(b.streams[0].track.enabled, false);
    assert.ok(b.recorders.every(r => r.state === 'inactive'));
    b.spoken.at(-1).onend();
    await b.advance(249);
    assert.equal(b.streams[0].track.enabled, false);
    await b.advance(1);
    assert.equal(b.status(), 'Listening…');
    assert.equal(b.recorders.at(-1).state, 'recording');
    assert.equal(b.streams[0].track.enabled, true);
  }
  const lateEnd = b.spoken[0].onend;
  const count = b.recorders.length;
  b.window.stopAlexVoiceSession();
  lateEnd?.(); await b.advance(2000);
  assert.equal(b.streams[0].track.readyState, 'ended');
  assert.equal(b.contexts[0].state, 'closed');
  assert.equal(b.recorders.length, count);
  assert.equal(b.timers.size, 0);
});

test('manual mute discards recording; unmute resumes, and a mute during TTS is preserved after speech ends', async () => {
  const b = browser(); await b.start();
  b.elements['alex-mic-toggle'].emit('click'); await flush();
  assert.equal(b.status(), 'Muted');
  assert.equal(b.streams[0].track.enabled, false);
  assert.equal(b.sttCalls().length, 0);
  b.elements['alex-mic-toggle'].emit('click'); await flush();
  assert.equal(b.status(), 'Listening…');
  b.energy(35); await b.advance(300); b.energy(0); await b.advance(450);
  b.elements['alex-mic-toggle'].emit('click');
  assert.equal(b.status(), 'Alex is speaking...');
  b.spoken[0].onend(); await b.advance(1000);
  assert.equal(b.status(), 'Muted');
  assert.equal(b.recorders.at(-1).state, 'inactive');
  b.elements['alex-mic-toggle'].emit('click');
  assert.equal(b.status(), 'Listening…');
  b.window.stopAlexVoiceSession();
});

test('End Call stops active speech immediately and stale callbacks cannot restart recording', async () => {
  const b = browser(); await b.start();
  b.energy(35); await b.advance(300); b.energy(0); await b.advance(450);
  const utterance = b.spoken[0], lateEnd = utterance.onend, count = b.recorders.length;
  const cancelled = b.cancelled();
  b.window.stopAlexVoiceSession();
  assert.equal(utterance.onend, null);
  assert.ok(b.cancelled() > cancelled);
  assert.equal(b.streams[0].track.readyState, 'ended');
  lateEnd(); await b.advance(2000);
  assert.equal(b.recorders.length, count);
  assert.equal(b.timers.size, 0);
});

test('ending while microphone permission is pending releases the late stream without starting recording', async () => {
  const permission = deferred(), b = browser({permission});
  const started = b.window.toggleAlexVoice();
  b.window.stopAlexVoiceSession();
  const stream = b.stream(); permission.resolve(stream);
  await started; await flush();
  assert.equal(stream.track.readyState, 'ended');
  assert.equal(b.recorders.length, 0);
  assert.equal(b.contexts[0].state, 'closed');
  assert.equal(b.timers.size, 0);
});

test('a late STT response after End Call is ignored and cannot call the reply model or restart the mic', async () => {
  const stt = deferred(), b = browser({stt}); await b.start();
  b.energy(35); await b.advance(300); b.energy(0); await b.advance(450);
  assert.equal(b.status(), 'Thinking…');
  const request = b.sttCalls()[0], count = b.recorders.length;
  b.window.stopAlexVoiceSession();
  assert.equal(request.init.signal.aborted, true);
  stt.resolve(b.json({text: 'Late transcription'})); await flush(); await b.advance(2000);
  assert.equal(b.calls.filter(c => c.url?.endsWith('voice-stream')).length, 0);
  assert.equal(b.recorders.length, count);
});

for (const exit of ['pagehide', 'beforeunload', 'component removal']) {
  test(`${exit} releases all tracks and cancels restart timers`, async () => {
    const b = browser(); await b.start();
    if (exit === 'component removal') b.removePanel(); else b.event(exit);
    assert.equal(b.streams[0].track.readyState, 'ended');
    assert.ok(b.recorders.every(r => r.state === 'inactive'));
    assert.equal(b.contexts[0].state, 'closed');
    await b.advance(2000);
    assert.equal(b.recorders.length, 1);
    assert.equal(b.timers.size, 0);
  });
}

test('reloading the controller cleans the previous call and replaces old button handlers', async () => {
  const b = browser(); await b.start(); b.reloadController();
  assert.equal(b.streams[0].track.readyState, 'ended');
  assert.equal(b.elements['alex-btn'].listeners.get('click').length, 1);
  await b.start();
  assert.equal(b.streams[1].track.enabled, true);
  b.window.stopAlexVoiceSession();
});

test('the maximum 15-second recording safety limit is retained', async () => {
  const b = browser(); await b.start(); b.energy(35);
  await b.advance(14975); assert.equal(b.sttCalls().length, 0);
  await b.advance(25); assert.equal(b.sttCalls().length, 1);
  b.window.stopAlexVoiceSession();
});

test('Safari gesture restrictions release the mic and offer Start Call instead of showing Muted', async () => {
  const b = browser({suspended: true});
  const started = b.window.toggleAlexVoice(); await flush(); await b.advance(1500); await started;
  assert.equal(b.streams[0].track.readyState, 'ended');
  assert.equal(b.elements['alex-btn'].textContent, 'Start Call');
  assert.notEqual(b.status(), 'Muted');
  assert.equal(b.timers.size, 0);
});

test('permission denial closes the audio context and leaves a usable Start Call button', async () => {
  const b = browser({permissionDenied: true}); await b.start();
  assert.equal(b.status(), 'Microphone permission required');
  assert.equal(b.elements['alex-btn'].textContent, 'Start Call');
  assert.equal(b.elements['alex-btn'].disabled, false);
  assert.equal(b.contexts[0].state, 'closed');
  assert.equal(b.window.__alex_mic_muted, false);
  assert.equal(b.timers.size, 0);
});

test('manual mute between stop() and onstop discards the clip without leaving processing stuck', async () => {
  const b = browser({delayedStop: true}); await b.start();
  b.energy(35); await b.advance(300); b.energy(0); await b.advance(450);
  assert.equal(b.status(), 'Thinking…');
  b.elements['alex-mic-toggle'].emit('click'); await b.completeStops();
  assert.equal(b.status(), 'Muted');
  assert.equal(b.sttCalls().length, 0);
  b.elements['alex-mic-toggle'].emit('click');
  assert.equal(b.status(), 'Listening…');
  assert.equal(b.recorders.at(-1).state, 'recording');
  b.window.stopAlexVoiceSession();
});

test('End Call cancels a pending recorder retry instead of reopening the microphone', async () => {
  const b = browser({startFailure: true}); await b.start();
  assert.equal(b.streams[0].track.enabled, false);
  b.window.stopAlexVoiceSession(); await b.advance(2000);
  assert.equal(b.recorders.length, 1);
  assert.equal(b.streams[0].track.readyState, 'ended');
  assert.equal(b.timers.size, 0);
});

test('a late greeting cannot interrupt a student question or play after the call ends', async () => {
  const b = browser(); await b.start(); b.energy(35); await b.advance(300);
  b.intro.resolve(b.json({text: 'Welcome', tts_mode: 'browser'})); await flush();
  assert.equal(b.spoken.length, 0);
  assert.equal(b.recorders.at(-1).state, 'recording');
  b.window.stopAlexVoiceSession();
  const c = browser(); await c.start(); c.window.stopAlexVoiceSession();
  c.intro.resolve(c.json({text: 'Late welcome', tts_mode: 'browser'})); await flush();
  assert.equal(c.spoken.length, 0);
  assert.equal(c.streams[0].track.readyState, 'ended');
});


test('final spoken transcript appears immediately before Alex replies, and both responsive panels retain turns', async () => {
  const reply = deferred(), b = browser({reply}); await b.start();
  b.energy(35); await b.advance(300); b.energy(0); await b.advance(450);
  for (const id of ['alex-chat-panel', 'alex-mobile-chat-panel']) {
    assert.equal(b.elements[id].children.length, 1);
    assert.equal(b.elements[id].children[0].className, 'alex-chat-bubble alex-chat-user');
    assert.equal(b.elements[id].children[0].textContent, 'Explain photosynthesis');
  }
  assert.equal(b.status(), 'Thinking…');
  reply.resolve(b.json({tts_mode: 'browser', text: 'Plants convert light into energy.'})); await flush();
  const panel = b.elements['alex-chat-panel'];
  assert.equal(panel.children.length, 2);
  assert.equal(panel.children[1].className, 'alex-chat-bubble alex-chat-alex');
  assert.equal(panel.scrollTop, panel.scrollHeight);
  b.window.stopAlexVoiceSession();
});

test('typed messages are immediate, appended in order, scroll to the newest turn, and retain forty recent messages', async () => {
  const b = browser(); await b.start();
  for (let i = 0; i < 22; i++) {
    b.elements['alex-type-input'].value = 'Question ' + i;
    b.elements['alex-type-send'].emit('click');
    const panel = b.elements['alex-chat-panel'];
    assert.equal(panel.children.at(-1).textContent, 'Question ' + i);
    await flush();
    assert.equal(panel.children.at(-1).className, 'alex-chat-bubble alex-chat-alex');
    assert.equal(panel.scrollTop, panel.scrollHeight);
    b.spoken.at(-1).onend(); await b.advance(250);
  }
  const panel = b.elements['alex-chat-panel'];
  assert.equal(panel.children.length, 40);
  assert.equal(panel.children[0].textContent, 'Question 2');
  assert.equal(panel.children.at(-2).textContent, 'Question 21');
  b.window.stopAlexVoiceSession();
});

for (const text of ['', '   ', null]) {
  test('empty or invalid STT transcript is not appended: ' + JSON.stringify(text), async () => {
    const stt = deferred(), b = browser({stt}); await b.start();
    b.energy(35); await b.advance(300); b.energy(0); await b.advance(450);
    stt.resolve(b.json({text})); await flush();
    assert.equal(b.elements['alex-chat-panel'].children.length, 0);
    assert.equal(b.calls.filter(c => c.url?.endsWith('voice-stream')).length, 0);
    assert.equal(b.status(), 'I couldn’t clearly hear that. Please try again.');
    await b.advance(1500); assert.equal(b.status(), 'Listening…');
    b.window.stopAlexVoiceSession();
  });
}

test('SSE rate-limit error is a retry notice, never spoken or stored as an Alex reply', async () => {
  const reply = deferred(), b = browser({reply}); await b.start();
  b.elements['alex-type-input'].value = 'Question'; b.elements['alex-type-send'].emit('click');
  reply.resolve(new Response('data: ' + JSON.stringify({type: 'error', error_code: 'rate_limit', message: 'provider internal details'}) + '\n\n', {headers: {'content-type': 'text/event-stream'}}));
  await flush();
  assert.equal(b.elements['alex-chat-panel'].children.length, 1);
  assert.equal(b.spoken.length, 0);
  assert.equal(b.elements['alex-transcript'].children.at(-1).textContent, 'Alex is getting a lot of requests right now. Try again in a moment.');
  b.window.stopAlexVoiceSession();
});

for (const [status, code, expected] of [
  [429, 'rate_limit', 'Alex is getting a lot of requests right now. Try again in a moment.'],
  [504, 'timeout', 'Alex took too long to respond. Please try again.'],
  [422, 'stt', 'I couldn’t clearly hear that. Please try again.'],
  [503, 'unavailable', 'Alex is temporarily unavailable. Please try again.'],
]) {
  test(`STT error ${status} shows a safe retry message and appends no transcript`, async () => {
    const stt = deferred(), b = browser({stt}); await b.start();
    b.energy(35); await b.advance(300); b.energy(0); await b.advance(450);
    stt.resolve(new Response(JSON.stringify({error: 'private provider error', error_code: code, text: 'bad transcript'}), {status}));
    await flush();
    assert.equal(b.elements['alex-chat-panel'].children.length, 0);
    assert.equal(b.status(), expected);
    assert.equal(b.elements['alex-transcript'].textContent, expected);
    b.window.stopAlexVoiceSession();
  });
}
