const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../assets/alex_voice.js'), 'utf8');
const helper = source.slice(source.indexOf('  function speakBrowserReply('),
  source.indexOf('  /**\n   * SSE: first audio'));

function load(available = true) {
  const spoken = [], notices = [];
  let resumed = 0;
  const context = vm.createContext({
    window: available ? {
      SpeechSynthesisUtterance: function (text) { this.text = text; },
      speechSynthesis: { getVoices: () => [{lang: 'en-US', localService: true}],
        speak: utterance => spoken.push(utterance), cancel() {} },
    } : {},
    document: {documentElement: {lang: 'en'}},
    browserUtterance: null, browserSpeechTimer: null, processing: false,
    active: true, callGeneration: 1, pauseMicrophone() {},
    isCurrentCall: generation => generation === 1,
    setTimeout: () => 1, clearTimeout() {}, setStatus() {}, setOrbState() {},
    appendVoiceServerNotice: text => notices.push(text),
    done: () => { resumed++; },
  });
  vm.runInContext(helper, context);
  return {context, spoken, notices, resumed: () => resumed};
}

test('demo reply speaks prepared text and resumes exactly once after speech ends', () => {
  const t = load();
  t.context.speakBrowserReply({speech_text: 'A clear reply.', voice_language: 'English'}, t.context.done);
  assert.equal(t.spoken[0].text, 'A clear reply.');
  assert.equal(t.spoken[0].lang, 'en-US');
  assert.equal(t.resumed(), 0);
  const ended = t.spoken[0].onend;
  ended(); ended();
  assert.equal(t.resumed(), 1);
});

test('unavailable browser speech preserves readable reply and resumes', () => {
  const t = load(false);
  t.context.speakBrowserReply({text: 'Readable reply'}, t.context.done);
  assert.equal(t.resumed(), 1);
  assert.match(t.notices[0], /Read the reply/);
});

test('browser speech error resumes instead of leaving the microphone stuck', () => {
  const t = load();
  t.context.speakBrowserReply({text: 'Readable reply'}, t.context.done);
  t.spoken[0].onerror();
  assert.equal(t.resumed(), 1);
  assert.equal(t.notices.length, 1);
  assert.equal(t.context.browserUtterance, null);
});

test('synchronous browser speech failure is handled', () => {
  const t = load();
  t.context.window.speechSynthesis.speak = () => { throw new Error('speech blocked'); };
  t.context.speakBrowserReply({text: 'Readable reply'}, t.context.done);
  assert.equal(t.resumed(), 1);
});

test('closing playback cancels browser speech without scheduling another listen', () => {
  const t = load();
  let cancelled = 0;
  t.context.window.speechSynthesis.cancel = () => { cancelled++; };
  t.context.speakBrowserReply({text: 'Reply'}, t.context.done);
  const stop = source.slice(source.indexOf('  function stopAlexPlaybackEngine()'),
    source.indexOf('  /**\n   * Queue one WAV'));
  Object.assign(t.context, {alexStreamActiveAudio: null, alexAudioChain: null,
    alexPendingSegments: 0, alexSseDone: false, playbackGeneration: 0, alexStreamObjectUrl: null});
  vm.runInContext(stop, t.context);
  t.context.stopAlexPlaybackEngine();
  assert.equal(cancelled, 1);
  assert.equal(t.resumed(), 0);
  assert.equal(t.spoken[0].onend, null);
});
