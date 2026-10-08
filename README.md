# Alex Studies 🚀
**A Full-Stack Academic Platform for University Students.**

Built with **Python** and the **Reflex** framework, Alex Studies is designed to centralize complex academic modules like Pure Mathematics, Statistics, and Physics into one high-performance dashboard.

## ✨ Key Features
* **Custom Dashboard:** Tailored for University of Kelaniya curriculum.
* **Integrated Tools:** Specialized calculators for advanced mathematics.
* **Fast Deployment:** Hosted on Railway for 99.9% uptime.
* **Seamless UI:** Minimalist dark-mode design for focused studying.

## 🛠 Tech Stack
* **Frontend/Backend:** [Reflex](https://reflex.dev/) (Python-based full stack)
* **Hosting:** Railway
* **Domain Management:** Cloudflare

## Voice Setup
For the cheapest natural-sounding Alex voice stack, keep `OPENROUTER_API_KEY` for chat and add OpenAI only for speech.

Recommended server env:

```bash
OPENROUTER_API_KEY=your_openrouter_key
OPENAI_API_KEY=your_openai_key
OPENAI_STT_MODEL=gpt-4o-mini-transcribe
OPENAI_TTS_MODEL=gpt-4o-mini-tts
OPENAI_TTS_VOICE=alloy
OPENAI_IMAGE_MODEL=gpt-image-1.5
```

Notes:
- `OPENROUTER_API_KEY` still powers Alex's teaching/chat model.
- `OPENAI_API_KEY` is used for voice transcription (STT), server-side TTS, and image generation.
- `OPENAI_IMAGE_MODEL` should be a supported OpenAI image model such as `gpt-image-1.5`, `gpt-image-1`, `gpt-image-1-mini`, or `dall-e-3`.

---
*Created by [Lenujan Paramanantham](https://alexstudies.com)*


## University demo mode (reversible)

Set these **server-side** variables in the backend environment, then restart the
backend. Do not use `NEXT_PUBLIC_` for credentials:

```dotenv
ALEX_DEMO_FREE_MODE=true
ALEX_TEXT_PROVIDER=groq
GROQ_API_KEY= # enter your own key locally, never commit it
GROQ_BASE_URL=https://api.groq.com/openai/v1
GROQ_TEXT_MODEL=openai/gpt-oss-20b
GROQ_STT_MODEL=whisper-large-v3-turbo
```

Use a Groq **Free plan** account. Demo mode prevents OpenAI, OpenRouter, and Fish
AI calls; it cannot change Groq account billing or guarantee free-tier capacity.
Text and auxiliary text tasks use one Groq model without router/escalation calls.
Existing system prompts, context, and SSE updates remain in place. Microphone
recordings use Groq STT; MP4 recordings receive an `.m4a` filename. Live voice
returns `tts_mode=browser`, prepared `speech_text`, and display text; no server
speech credits are required. Browser speech errors leave the reply readable and
resume listening. Available voices/languages depend on the event device.

Images, image understanding, automatic AI illustrations, and live AI video
creation are blocked in demo mode. Groq failures show a retry message and never
switch to a paid AI provider. Other integrations (payments, YouTube/Supadata,
proxy services, database hosting) retain their existing configuration; keep
those out of a no-cost event flow unless separately verified.

For deployment, set `REFLEX_API_URL` to the correct public API origin (normally
`https://alexstudies.com` through the proxy); do not leave a localhost URL in a
production frontend. Authenticate the event account before opening live voice.
Set `ALEX_DEMO_FREE_MODE=true` on the separate video service as well if deployed.

Groq requests use a 35-second network inactivity timeout and 5-second connect
timeout. The Next proxy allows 45 seconds for voice HTTP calls and a bounded
90 seconds for voice SSE, preserving streams beyond its former 30-second limit.
Demo text output is capped at 2048 tokens, voice replies at the existing 220.
Long context can still hit Groq Free plan token limits. Test the venue network,
HTTPS microphone access, browser speech, and quotas before the event.

To restore the original providers, set `ALEX_DEMO_FREE_MODE=false` and
`ALEX_TEXT_PROVIDER=openrouter`, keep the original provider keys, and restart.
No original provider implementation has been removed. Defaults remain unchanged
until demo mode is explicitly enabled.

Verify before enabling the event environment:

```sh
.venv_new/bin/python -m unittest discover -s tests -p 'test_*.py'
node --test next-app/tests/regressions.cjs tests/test_voice_auth.cjs tests/test_browser_tts.cjs
.venv_new/bin/python tools/smoke_demo.py
```

The smoke test uses only Groq, consumes account quota, and does not print keys or
provider error bodies. Its synthetic silent WAV checks STT endpoint acceptance;
test an actual spoken question on the event browser separately.
