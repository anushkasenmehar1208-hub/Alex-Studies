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

## Smart Exam Forecast (AI Predicted Paper)

Students upload 3–5 past paper PDFs (plus optional syllabus and marking
schemes); a multi-model OpenRouter pipeline produces a high-probability
pattern-based mock paper, an answer guide, and a deterministic
leave-one-out backtest score. Implemented in `uni_app/exam_forecast.py`,
wired into the Reflex app at `/exam-forecast`.

**Required env var:** `OPENROUTER_API_KEY` (already used for chat).

**Optional model overrides** — every pipeline stage uses an OpenRouter
slug that can be overridden per-deployment without redeploying code:

```bash
EXAM_FORECAST_EXTRACTION_MODEL=openai/gpt-5.5-pro
EXAM_FORECAST_LONG_CONTEXT_MODEL=google/gemini-3.1-pro-preview
EXAM_FORECAST_PATTERN_MODEL=anthropic/claude-opus-4.7
EXAM_FORECAST_RIVAL_MODEL=openai/gpt-5.5-pro
EXAM_FORECAST_CONSENSUS_MODEL=anthropic/claude-opus-4.7
EXAM_FORECAST_JUDGE_MODEL=openai/gpt-5.5-pro
EXAM_FORECAST_FINAL_POLISH_MODEL=anthropic/claude-opus-4.7
```

If a slug is not available on OpenRouter, the pipeline fails clearly
with the failing model name surfaced to the operator — no silent
fallback to weaker models. Override the relevant env var to the
correct slug and retry.

This feature adds `reportlab>=4.0` to `requirements.txt` for
deterministic PDF rendering of the predicted paper and answer guide
(no AI in the layout step).

---
*Created by [Lenujan Paramanantham](https://alexstudies.com)*
