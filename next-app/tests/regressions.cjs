const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');
const root = path.join(__dirname, '..');

class NextResponse extends Response {
  static next() { return new NextResponse(null, { headers: { 'x-proxy-next': '1' } }); }
  static redirect(url) { return new NextResponse(null, { status: 307, headers: { location: String(url) } }); }
  static json(body, options) { return Response.json(body, options); }
}
function load(file, { mocks = {}, globals = {}, expose = '' } = {}) {
  const source = fs.readFileSync(path.join(root, 'src', file), 'utf8') + expose;
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    reportDiagnostics: true,
    fileName: file,
  });
  assert.equal(output.diagnostics.length, 0);
  const exports = {};
  vm.runInNewContext(output.outputText, {
    exports, require: (name) => {
      if (name === 'next/server') return { NextResponse };
      if (name in mocks) return mocks[name];
      throw new Error(`Unexpected dependency: ${name}`);
    },
    process: { env: { REFLEX_BACKEND_URL: 'https://backend.example.test' } },
    URL, Headers, Response, AbortSignal, Buffer, console, ...globals,
  }, { filename: file });
  return exports;
}
function request(route) {
  return { nextUrl: new URL(route, 'https://frontend.example.test'), method: 'GET', headers: {}, cookies: { get: () => undefined, toString: () => '' } };
}

test('all Next pages and public assets bypass the backend', async () => {
  const { proxy } = load('proxy.ts', { globals: { fetch: () => { throw new Error('Unexpected backend request'); } } });
  const routes = ['/', '/login', '/register', '/forgot-password', '/privacy', '/select', '/onboarding', '/generate-plan', '/exam-forecast', '/learn-with-youtube', '/robots.txt', '/sitemap.xml'];
  routes.push(...fs.readdirSync(path.join(root, 'public')).map(name => '/' + name));
  for (const route of routes) {
    assert.equal((await proxy(request(route))).headers.get('x-proxy-next'), '1', route);
  }
});
test('backend outages produce a controlled 502', async () => {
  const { proxy } = load('proxy.ts', { globals: { fetch: async () => { throw new Error('offline'); } } });
  const response = await proxy(request('/s/home'));
  assert.equal(response.status, 502);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});
test('proxy preserves API paths and adds a slash only for SPA pages', async () => {
  const urls = [];
  const { proxy } = load('proxy.ts', { globals: { fetch: async url => { urls.push(url); return new Response('OK'); } } });
  await proxy(request('/s/home?tab=notes'));
  await proxy(request('/auth/google/start'));
  assert.deepEqual(urls, ['https://backend.example.test/s/home/?tab=notes', 'https://backend.example.test/auth/google/start']);
});
test('backend absolute and relative redirects stay on the frontend', async () => {
  for (const location of ['https://backend.example.test/s/home/?x=1', '/s/home/?x=1']) {
    const { proxy } = load('proxy.ts', { globals: { fetch: async () => new Response(null, { status: 302, headers: { location } }) } });
    const response = await proxy(request('/app'));
    assert.equal(response.headers.get('location'), 'https://frontend.example.test/s/home/?x=1');
  }
});
test('external OAuth redirects are preserved, including lookalike origins', async () => {
  for (const location of ['https://accounts.google.com/login', 'https://backend.example.test.evil.test/login']) {
    const { proxy } = load('proxy.ts', { globals: { fetch: async () => new Response(null, { status: 302, headers: { location } }) } });
    assert.equal((await proxy(request('/app'))).headers.get('location'), location);
  }
});
test('blocked storage does not prevent cookie-based authentication', () => {
  const window = {};
  Object.defineProperty(window, 'localStorage', { get() { throw new Error('Access denied'); } });
  assert.equal(load('lib/browser-storage.ts', { globals: { window } }).readBrowserToken('_auth_token'), '');
});
test('plain and Reflex JSON-encoded tokens are supported', () => {
  for (const raw of ['token', '"token"']) {
    const window = { localStorage: { getItem: () => raw } };
    assert.equal(load('lib/browser-storage.ts', { globals: { window } }).readBrowserToken('_auth_token'), 'token');
  }
});
test('Software Engineering is resolved using country context', () => {
  const { resolveDegreeName } = load('app/api/onboarding/complete/route.ts', { mocks: { '@/lib/auth': {}, '@/lib/db': {} }, expose: '\nexport { resolveDegreeName };' });
  assert.equal(resolveDegreeName('uk', 'se'), 'Software Engineering (UK)');
  assert.equal(resolveDegreeName('us', 'se'), 'Software Engineering (US)');
  assert.equal(resolveDegreeName('lk', 'se'), 'Software Engineering');
});
test('password recovery never claims an unsent email was sent', async () => {
  const response = await load('app/api/auth/forgot-password/route.ts').POST();
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /not available/);
});
test('registration rejects malformed emails and invalid passwords before database access', async () => {
  const { POST } = load('app/api/auth/register/route.ts', { mocks: { '@/lib/auth': {} } });
  for (const fields of [
    { email: 'invalid', password: 'Validpass1' },
    { email: 'a@example.com', password: 'aaaaaaaa' },
    { email: 'a@example.com', password: 'a1' + '😀'.repeat(20) },
  ]) {
    const response = await POST({ json: async () => ({ username: 'student', ...fields }), cookies: { get: () => undefined } });
    assert.equal(response.status, 400);
  }
});

test('onboarding rejects invalid selections without writing to the database', async () => {
  const { POST } = load('app/api/onboarding/complete/route.ts', {
    mocks: { '@/lib/auth': { getSessionUserId: async () => 1 }, '@/lib/db': {} },
  });
  for (const fields of [
    { country: 'uk', degree: 'ps', semester: 'y1s1' },
    { country: 'uk', degree: 'cs', semester: 'y1s4' },
    { country: 'lk', degree: 'ps', semester: 'y1s1' },
  ]) {
    const response = await POST({ json: async () => fields, cookies: { get: () => ({ value: 'session' }) } });
    assert.equal(response.status, 400);
  }
});
