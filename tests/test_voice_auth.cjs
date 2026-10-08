const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../assets/alex_voice.js'), 'utf8');
// Exercise the production request-header builders without audio devices or a DOM.
const helpers = source.slice(source.indexOf('  function authToken()'),
  source.indexOf('  function applyAlexLanguagePrefsFromVoice'));

function load(raw, denied = false) {
  const context = vm.createContext({
    window: { ALEX_AUTH_STORAGE_KEY: '_auth_token' },
    localStorage: { getItem() { if (denied) throw new Error('Storage denied'); return raw; } },
  });
  vm.runInContext(helpers, context);
  return context;
}

test('intro, reply, STT and sync send the same decoded authentication token', () => {
  for (const raw of ['session-token', '"session-token"', '  "session-token"  ']) {
    const client = load(raw);
    for (const headers of [client.authHeadersForGet(), client.authHeadersJson(),
      client.authHeadersForStt('audio/webm')]) {
      assert.equal(headers['X-Auth-Token'], 'session-token');
      assert.equal(headers.Authorization, undefined);
    }
  }
});

test('missing, invalid or inaccessible storage sends no authentication token', () => {
  for (const raw of [null, '', 'null', '{}', '123']) {
    assert.equal(load(raw).authHeadersForGet()['X-Auth-Token'], undefined);
  }
  assert.equal(load('secret', true).authHeadersForGet()['X-Auth-Token'], undefined);
});

test('anonymous voice requests carry only the server-issued scoped capability', () => {
  const client = load(null);
  client.window.ALEX_VOICE_KEY = 'guest-voice-capability';
  for (const headers of [client.authHeadersForGet(), client.authHeadersJson(), client.authHeadersForStt('audio/mp4')]) {
    assert.equal(headers['X-Alex-Voice-Key'], 'guest-voice-capability');
    assert.equal(headers['X-Auth-Token'], undefined);
  }
  const account = load('account-token');
  account.window.ALEX_VOICE_KEY = 'guest-voice-capability';
  assert.equal(account.authHeadersJson()['X-Auth-Token'], 'account-token');
  assert.equal(account.authHeadersJson()['X-Alex-Voice-Key'], undefined);
});
