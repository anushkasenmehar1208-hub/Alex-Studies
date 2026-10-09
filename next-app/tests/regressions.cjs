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
test('voice proxy deadlines exceed the Groq backend timeout and retain a bounded SSE lifetime', async () => {
  const deadlines = [];
  const { proxy } = load('proxy.ts', { globals: {
    AbortSignal: { timeout(ms) { deadlines.push(ms); return undefined; } },
    fetch: async () => new Response('OK'),
  } });
  await proxy(request('/api/alex-voice-stt'));
  await proxy(request('/api/alex-voice'));
  await proxy(request('/api/alex-voice-stream'));
  await proxy(request('/s/home'));
  assert.deepEqual(deadlines, [45000, 45000, 90000, 30000]);
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

// ── Landing → onboarding routing ───────────────────────────────

function collectHrefs(node, hrefs = []) {
  if (!node) return hrefs;
  if (Array.isArray(node)) {
    for (const child of node) collectHrefs(child, hrefs);
    return hrefs;
  }
  if (typeof node !== 'object') return hrefs;
  if (node.props) {
    if (typeof node.props.href === 'string') {
      hrefs.push({ href: node.props.href, children: node.props.children });
    }
    collectHrefs(node.props.children, hrefs);
  }
  return hrefs;
}

test('landing Start My Study Plan opens the onboarding route', () => {
  const { Hero } = load('components/landing/Hero.tsx', {
    mocks: {
      'react/jsx-runtime': {
        jsx: (type, props) => ({ type, props }),
        jsxs: (type, props) => ({ type, props }),
        Fragment: 'Fragment',
      },
      'next/link': { default: (props) => ({ type: 'a', props }) },
      'next/image': { default: () => null },
    },
  });
  const links = collectHrefs(Hero());
  const cta = links.find((link) =>
    typeof link.children === 'string' && link.children.includes('Start My Study Plan')
  );
  assert.ok(cta, 'Start My Study Plan CTA is rendered');
  assert.equal(cta.href, '/select');
  assert.ok(!links.some((link) => link.href === '/app'),
    'no landing link jumps straight into the app');
});

function loadOnboardingRouting() { return load('lib/onboarding-routing.ts'); }

test('anonymous visitors without completed onboarding get the form, not /login or the app', () => {
  const { decideOnboardingEntry } = loadOnboardingRouting();

  const guest = decideOnboardingEntry({ status: 401, hasAuth: false, memory: null, savedScope: '' });
  assert.equal(guest.action, 'form');

  const expiredSession = decideOnboardingEntry({ status: 401, hasAuth: true, memory: null, savedScope: '' });
  assert.equal(expiredSession.action, 'login');

  const signedInReady = decideOnboardingEntry({ status: 200, hasAuth: true, memory: null, savedScope: '' });
  assert.equal(signedInReady.action, 'form');

  const statusUnavailable = decideOnboardingEntry({ status: 503, hasAuth: false, memory: null, savedScope: '' });
  assert.equal(statusUnavailable.action, 'form');
});

test('returning visitors with completed onboarding keep skipping the form', () => {
  const { decideOnboardingEntry } = loadOnboardingRouting();
  const memory = {
    is_started: true,
    degree: 'Software Engineering',
    selected_year: 'Year 2',
    selected_semester: 'Semester 4',
  };

  const account = decideOnboardingEntry({ status: 200, hasAuth: true, memory, savedScope: '' });
  assert.equal(account.action, 'app');
  assert.equal(account.to, '/app');

  // Guest defaults (is_started=true from demo state) never arrive here:
  // the status endpoint only reports real account memory, so an
  // unstarted account is still sent to the form.
  const unstarted = decideOnboardingEntry({
    status: 200,
    hasAuth: true,
    memory: { ...memory, is_started: false },
    savedScope: '',
  });
  assert.equal(unstarted.action, 'form');

  // A guest who already finished onboarding on this device resumes at
  // their scope instead of redoing the form.
  const returningGuest = decideOnboardingEntry({
    status: 200,
    hasAuth: false,
    memory: { ...memory, selected_year: 'Year 2', selected_semester: 'Semester 4' },
    savedScope: '',
  });
  assert.equal(returningGuest.action, 'app');
  assert.equal(returningGuest.to, '/app?onboarded=1&scope=y2s4');
});

test('onboarding completion routes into the app for guests and accounts', () => {
  const { decideOnboardingFinish } = loadOnboardingRouting();

  const account = decideOnboardingFinish({ status: 200, hasAuth: true, scope: 'y1s2' });
  assert.equal(account.action, 'continue');
  assert.equal(account.to, '/app?onboarded=1&scope=y1s2');

  // Only successfully saved guest onboarding may enter the app.
  const guest = decideOnboardingFinish({ status: 200, hasAuth: false, scope: 'y2s4' });
  assert.equal(guest.action, 'continue');
  assert.equal(guest.to, '/app?onboarded=1&scope=y2s4');

  const expiredSession = decideOnboardingFinish({ status: 401, hasAuth: true, scope: 'y1s1' });
  assert.equal(expiredSession.action, 'error');

  const invalid = decideOnboardingFinish({ status: 400, hasAuth: false, scope: 'y1s1' });
  assert.equal(invalid.action, 'error');
});

test('completed onboarding lands on the chosen workspace scope', async () => {
  const { proxy } = load('proxy.ts', { globals: { fetch: () => { throw new Error('Unexpected backend request'); } } });
  const response = await proxy(request('/app?onboarded=1&scope=y2s4'));
  assert.equal(response.status, 307);
  assert.equal(response.headers.get('location'), 'https://frontend.example.test/s/y2s4');
});

test('app, workspace and voice routes still proxy to the backend', async () => {
  const urls = [];
  const { proxy } = load('proxy.ts', { globals: { fetch: async (url) => { urls.push(url); return new Response('OK'); } } });
  await proxy(request('/app'));
  await proxy(request('/s/home'));
  await proxy(request('/api/alex-voice-stt'));
  assert.deepEqual(urls, [
    'https://backend.example.test/app/',
    'https://backend.example.test/s/home/',
    'https://backend.example.test/api/alex-voice-stt',
  ]);
});

function guestRequest(body, token = 'g_' + 'a'.repeat(32)) {
  return { headers: new Headers({ 'x-alex-guest-token': token }), json: async () => body };
}
function loadGuest(sql) {
  return load('app/api/onboarding/guest/route.ts', { mocks: {
    'node:crypto': require('node:crypto'), '@/lib/db': { sql },
  } });
}
test('fresh guest has no completed plan; demo defaults do not skip onboarding', async () => {
  const defaults = { is_started: true, degree: 'Software Engineering', selected_year: 'Year 1', selected_semester: 'Semester 1', summary: 'Anonymous exhibition session. No prior achievements or completed topics are known.' };
  for (const rows of [[], [defaults]]) {
    const response = await loadGuest(async () => rows).GET(guestRequest());
    assert.equal(response.status, 200);
    const { memory } = await response.json();
    assert.ok(!memory || !memory.is_started);
  }
});
test('guest completion persists canonical choices only in Reflex guest namespace', async () => {
  const calls = [];
  const { POST, GET } = loadGuest(async (strings, ...values) => { calls.push({ strings, values }); return []; });
  const response = await POST(guestRequest({ country: 'uk', degree: 'cs', semester: 'y2s4' }));
  assert.equal(response.status, 200);
  // Fixture computed by Python Reflex _guest_uid_from_token.
  assert.equal(calls[0].values[0], 1944385154);
  assert.ok(calls[0].values.includes('Computer Science (UK)'));
  assert.ok(calls[0].values.includes('Year 2'));
  assert.ok(calls[0].values.includes('Semester 4'));
  assert.doesNotMatch(calls[0].strings.join(''), /userprofile|chatsession|chatmessage/i);
  await GET(guestRequest());
  assert.equal(calls[1].values[0], calls[0].values[0]);
  await GET(guestRequest(undefined, 'g_' + 'b'.repeat(32)));
  assert.notEqual(calls[2].values[0], calls[0].values[0]);
});
test('returning guest completion is read without exposing other fields', async () => {
  const { GET } = loadGuest(async () => [{ is_started: true, degree: 'Physical Science', selected_year: 'Year 1', selected_semester: 'Semester 2', summary: 'Personal learning context', secret: 'not returned' }]);
  const data = await (await GET(guestRequest())).json();
  assert.equal(data.memory.is_started, true);
  assert.equal(data.memory.selected_semester, 'Semester 2');
  assert.equal(data.memory.summary, undefined);
  assert.equal(data.memory.secret, undefined);
});
test('guest onboarding rejects invalid identity, bad selections and storage failure', async () => {
  const never = loadGuest(async () => { throw new Error('unexpected database access'); });
  assert.equal((await never.GET(guestRequest(undefined, '1'))).status, 401);
  assert.equal((await never.POST(guestRequest({ country: 'uk', degree: 'ps', semester: 'y1s1' }))).status, 400);
  assert.equal((await never.POST(guestRequest({ country: 'uk', degree: 'cs', semester: 'y1s1' }))).status, 503);
  const { decideOnboardingFinish } = loadOnboardingRouting();
  assert.equal(decideOnboardingFinish({ status: 401, hasAuth: false, scope: 'y1s1' }).action, 'error');
});

test('existing form exposes degree then semester then country and preserves valid choices', () => {
  const setters = [];
  const values = ['', 'se', '', false, 'y1s2', false, false, '', false];
  let stateIndex = 0;
  const tree = load('app/onboarding/page.tsx', { mocks: {
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'Fragment' },
    react: { useEffect: () => {}, useMemo: fn => fn(), useState: () => { const i = stateIndex++; return [values[i], value => setters.push([i, value])]; } },
    'framer-motion': { motion: {}, AnimatePresence: 'AnimatePresence' },
    'lucide-react': { Check: 'Check', ChevronDown: 'ChevronDown' },
    '@/lib/browser-storage': { readBrowserToken: () => '' },
    '@/lib/onboarding-routing': loadOnboardingRouting(),
  } }).default();
  const nodes = [];
  function walk(n) {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== 'object') return;
    nodes.push(n); walk(n.props?.children);
  }
  walk(tree);
  const titles = nodes.map(n => n.props?.title).filter(Boolean);
  assert.ok(titles.indexOf('What are you studying?') < titles.indexOf('Which semester are you in?'));
  assert.ok(titles.indexOf('Which semester are you in?') < titles.indexOf('Where do you study?'));
  nodes.find(n => n.props?.title === 'Sri Lanka').props.onClick();
  assert.ok(setters.some(([i, v]) => i === 0 && v === 'lk'));
  assert.ok(!setters.some(([i]) => i === 1 || i === 4), 'country selection keeps the compatible degree and semester');
});
