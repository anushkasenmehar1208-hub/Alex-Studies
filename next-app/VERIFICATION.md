# Verification results — 2026-10-05

The current source, assets, configuration, tests, and package lock were copied to `/private/tmp/alexstudies-verification`. Production secrets were excluded. A fresh `npm ci` from the official registry installed the exact locked dependencies and bypassed macOS cloud placeholders.

## Passed

- `npm run lint`
- `npx tsc --noEmit`
- `npm test`: 11 tests
- `npm run build`: compiled successfully and generated all 16 static outputs
- Production server startup at http://127.0.0.1:3100
- Browser: sample teaching demo, chat preview, FAQ expansion, login navigation/password visibility, registration labels/password guidance, recovery navigation, feature-page home navigation, and unauthenticated onboarding redirect
- Responsive homepage widths: 390, 768, and 1280 pixels without horizontal overflow; mobile auth/recovery/feature pages also checked
- All 12 local public files and 11 local page/metadata URLs returned 200; optimized hero image returned 200
- No browser console errors or warnings observed in tested local interactions

The additional fixes from this verification are the feature-page home Link, a scoped ESLint rule for CommonJS tests, and migration to Next.js 16's src/proxy.ts convention. The previous deprecation warning is gone.

## Live outage

On https://alexstudies.com, 29 public URLs were checked: 8 returned 200 and 21 returned 502.

200: homepage, login, registration, generate-plan, exam-forecast, learn-with-youtube, robots.txt, sitemap.xml.

502: forgot-password, app, privacy, privacy-policy, terms, return-policy, support, pricing, all 11 study-plan links in the footer, a_logo.png, landing-hero-demo.png.

Both backend.alexstudies.com and alex-studies.onrender.com return 502 at ping and health/root checks, with Render identified in the response headers. The cause of that deployed backend startup failure requires the latest Render deploy/startup log. The configured /health route exists in the application.

The local recovery route works. /privacy redirects to /privacy-policy, so it still requires the unavailable backend. The live login still shows the old unlabelled password control, confirming the local fixes are not deployed.

## Limits and next steps

No deployment, production database writes, accounts, emails, or payments were performed. Authenticated workspace, voice/WebSocket, backend Python tests, and payment flows remain unverified.

Repair Render using its latest startup log, deploy the frontend fixes, then test authenticated workflows against test data. Email password recovery still needs a secure token flow and configured email delivery.

The original workspace dependencies remain cloud-managed: moving their directory stalled and was cancelled before it moved. The downloaded verification copy is usable. This frontend build/browser verification does not establish that the entire live website is error-free.
