"""Opt-in Groq smoke test; uses only Groq and never prints credentials.

Run from the repository: .venv_new/bin/python tools/smoke_demo.py
The STT check uses a synthetic silent WAV: it verifies endpoint acceptance,
not transcription accuracy. These three requests consume Groq account quota.
"""
import asyncio
import io
import os
from pathlib import Path
import sys
import wave

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env")
os.environ["ALEX_DEMO_FREE_MODE"] = "true"
sys.path.insert(0, str(ROOT))
from uni_app import ai_provider


async def main():
    config = ai_provider.CONFIG
    if not config.api_key:
        raise SystemExit("Smoke test not run: configure GROQ_API_KEY in the server .env first.")
    messages = [{"role": "system", "content": "Give one short sentence."},
                {"role": "user", "content": "Explain what a university study plan is."}]
    try:
        text = await asyncio.to_thread(ai_provider.complete, config, messages, 512)
        streamed = "".join([part async for part in ai_provider.stream(config, messages, 512)])
        audio = io.BytesIO()
        with wave.open(audio, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(16000)
            wav.writeframes(b"\0\0" * 16000)
        await ai_provider.transcribe(config, audio.getvalue(), "audio/wav")
        print(f"Text: {config.text_model}, nonempty response: {bool(text.strip())}")
        print(f"SSE: {config.text_model}, nonempty response: {bool(streamed.strip())}")
        print(f"STT: {config.stt_model}, synthetic WAV accepted")
    except Exception:
        # Provider exception strings may contain request details; do not print them.
        raise SystemExit("Groq smoke test failed. Check the account key, model access, quota, and network.")


if __name__ == "__main__":
    asyncio.run(main())
