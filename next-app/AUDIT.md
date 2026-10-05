# Website audit — 2026-10-05

## Fixed

- Next.js password recovery, privacy, and public assets were incorrectly sent to Reflex by the proxy.
- Backend request failures now return a controlled, non-cacheable 502 response and have a 30-second timeout.
- Backend redirects are resolved by URL origin, including relative redirects, without rewriting lookalike external hosts.
- Onboarding only navigates after a successful save; failures are displayed and can be retried. The submit button remains visible while saving.
- Unauthenticated onboarding visitors are sent to login.
- UK and US Software Engineering selections retain their country-specific degree names.
- Invalid country/degree combinations, semester scopes, and missing required pathways are rejected before database writes.
- Login, registration, and onboarding tolerate browsers that deny localStorage access.
- Login and registration fields have associated labels, password-toggle names, and announced errors.
- Registration validates email, enforces the password requirements shown by the form, and rejects passwords beyond bcrypt's 72-byte limit.
- Onboarding status failures return structured JSON instead of an unhandled error.
- Removed false claims that password-reset emails were sent. Recovery now directs users to existing support; the API explicitly reports that email recovery is unavailable.

## Verification completed — 2026-10-05

A fresh verification copy was made at `/private/tmp/alexstudies-verification`, containing the project's source, public assets, configuration, tests, and exact package lock. `npm ci` installed 370 packages from the official registry there. Production secrets were not copied.

- `npm run lint`: passed after correcting the home link in FeatureLandingPage and allowing CommonJS imports specifically in CommonJS test files.
- `npx tsc --noEmit`: passed.
- `npm test`: all 11 regression tests passed.
- `npm run build`: passed; all 16 static outputs generated. Migrated src/middleware.ts to src/proxy.ts and the named proxy export required by Next.js 16, removing the deprecation warning.
- Production server: started on http://127.0.0.1:3100.
- Browser checks: homepage demo, chat preview, FAQ expansion, login navigation, password visibility control, registration labels/password guidance, repaired password recovery, feature-page home navigation, and unauthenticated onboarding redirect to login worked.
- Responsive checks: homepage widths 390, 768, and 1280 pixels had document scrollWidth equal to the viewport. Mobile login, registration, recovery, and feature page had no horizontal overflow. Mobile screenshots were visually inspected.
- HTTP checks: all 12 local public assets and 11 local page/metadata URLs returned 200. `/privacy` redirects to `/privacy-policy`, which depends on the currently unavailable backend and returned 502.
- Optimized image request returned 200; homepage hero image loaded. No warning/error console entries were observed during the tested local interactions.

The cloud-file build blocker was bypassed using downloaded dependencies in the verification copy. An attempt to move the original cloud-managed dependency folder out of the workspace stalled and was cancelled before it moved. The original workspace dependencies remain cloud-managed. The Python suite and authenticated backend flows were not completed by this frontend verification.

## Live website results

Checked https://alexstudies.com on 2026-10-05, approximately 14:20 Asia/Colombo. Of 29 public URLs checked, 8 returned 200 and 21 returned 502.

| Result | Routes |
| --- | --- |
| 200 | /, /login, /register, /generate-plan, /exam-forecast, /learn-with-youtube, /robots.txt, /sitemap.xml |
| 502 | /forgot-password, /app, /privacy, /privacy-policy, /terms, /return-policy, /support, /pricing |
| 502 | /ai-study-planner-for-university-students, /uk-computer-science-study-plan, /uk-software-engineering-study-plan, /us-computer-science-study-plan, /us-software-engineering-study-plan |
| 502 | /sri-lanka-software-engineering-study-plan, /sri-lanka-becs-study-plan, /sri-lanka-physical-science-study-plan, /sri-lanka-biological-science-study-plan, /india-btech-computer-science-study-plan, /india-btech-information-technology-study-plan |
| 502 | /a_logo.png, /landing-hero-demo.png |

The live homepage sample demo and login page were checked in a browser. The live Forgot password link failed to navigate; direct HTTP confirmed 502. The live login page still has the old unlabelled password control, indicating the local changes are not deployed.

Both `https://backend.alexstudies.com/ping` and the configured `https://alex-studies.onrender.com/ping` return 502 with `x-render-origin-server: Render`. Their root/health checks also return 502. This establishes backend unavailability, but its startup cause requires Render deployment logs. The configured healthCheckPath `/health` is registered in the Python application, so no health-path mismatch was found.

## Remaining work

1. Obtain the latest Render backend deploy/startup error log and repair the service's startup failure. Source inspection alone does not establish why the running deployment is unavailable.
2. Deploy the verified frontend fixes to restore locally owned routes/assets on the public domain. No deployment was performed in this session.
3. After the backend is healthy, verify authenticated login/onboarding, workspace navigation, voice/WebSocket behavior, and payment flows against test data.
4. Implement secure expiring-token email recovery with a configured delivery service; the current page correctly reports its unavailability.

No production database writes, account creation, emails, purchases, or payments were exercised. The site cannot be described as error-free while its backend returns 502.
