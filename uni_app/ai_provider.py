"""Server-only provider selection for the reversible university demo."""
from dataclasses import dataclass
import json
import os
from urllib.parse import urlparse

import httpx


DEMO_ERROR = "Alex is temporarily unavailable. Please try again."
RATE_ERROR = "Alex is getting a lot of requests right now. Try again in a moment."
TIMEOUT_ERROR = "Alex took too long to respond. Please try again."
STT_ERROR = "I couldn’t clearly hear that. Please try again."


class ProviderResponseError(RuntimeError):
    def __init__(self, kind, finish_reason=None):
        self.kind = kind
        self.finish_reason = finish_reason if finish_reason in ("length", "stop", "content_filter") else None
        super().__init__(kind)


class VoiceProviderError(RuntimeError):
    def __init__(self, message, code, status):
        self.code, self.status = code, status
        super().__init__(message)


def failure(exc, endpoint, config, logger):
    """Log metadata only: never exception text, bodies, headers, keys or transcripts."""
    upstream_status = exc.response.status_code if isinstance(exc, httpx.HTTPStatusError) else None
    if upstream_status == 429:
        code, message, status = "rate_limit", RATE_ERROR, 429
    elif upstream_status in (408, 504) or isinstance(exc, (httpx.TimeoutException, httpx.NetworkError)):
        code, message, status = "timeout", TIMEOUT_ERROR, 504
    elif endpoint == "stt" and (upstream_status in (400, 413, 415, 422)
                               or isinstance(exc, ProviderResponseError) and exc.kind == "empty_transcript"):
        code, message, status = "stt", STT_ERROR, 422
    else:
        code, message, status = "unavailable", DEMO_ERROR, 503
    summary = (exc.kind if isinstance(exc, ProviderResponseError) else
               "http_error" if upstream_status else
               "timeout" if isinstance(exc, httpx.TimeoutException) else
               "network_error" if isinstance(exc, httpx.NetworkError) else "backend_error")
    if upstream_status:
        try:
            provider_code = exc.response.json().get("error", {}).get("code")
            if provider_code in {"invalid_api_key", "model_not_found", "model_decommissioned",
                                 "rate_limit_exceeded", "invalid_request_error", "context_length_exceeded"}:
                summary = "http_error:" + provider_code
        except (ValueError, AttributeError, httpx.ResponseNotRead):
            pass
    logger.warning("AI failure endpoint=%s provider=groq model=%s http_status=%s summary=%s finish_reason=%s paid_fallback=false",
                   endpoint, config.stt_model if endpoint == "stt" else config.text_model,
                   upstream_status or (200 if isinstance(exc, ProviderResponseError) else "none"),
                   summary, getattr(exc, "finish_reason", None))
    return VoiceProviderError(message, code, status)


@dataclass(frozen=True)
class ProviderConfig:
    demo: bool
    provider: str
    api_key: str
    base_url: str
    text_model: str
    stt_model: str

    @classmethod
    def from_env(cls):
        demo = os.getenv("ALEX_DEMO_FREE_MODE", "false").lower().strip() in ("true", "1", "yes")
        provider = "groq" if demo else os.getenv("ALEX_TEXT_PROVIDER", "openrouter").lower().strip()
        if provider not in ("groq", "openrouter"):
            raise ValueError("ALEX_TEXT_PROVIDER must be groq or openrouter")
        base = (os.getenv("GROQ_BASE_URL") or "https://api.groq.com/openai/v1").strip().rstrip("/")
        # A demo configuration must not accidentally send the key to another provider.
        parsed = urlparse(base)
        if demo and (parsed.scheme != "https" or parsed.netloc != "api.groq.com" or parsed.path != "/openai/v1"):
            raise ValueError("Free demo mode requires https://api.groq.com/openai/v1")
        return cls(demo, provider, os.getenv("GROQ_API_KEY", "").strip(), base,
                   (os.getenv("GROQ_TEXT_MODEL") or "openai/gpt-oss-20b").strip(),
                   (os.getenv("GROQ_STT_MODEL") or "whisper-large-v3-turbo").strip())

    @property
    def uses_groq(self):
        return self.provider == "groq"

    @property
    def blocks_paid(self):
        return self.demo

    def headers(self):
        if not self.api_key:
            raise RuntimeError("Demo AI is not configured. Ask the organizer to set GROQ_API_KEY on the server.")
        return {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}


CONFIG = ProviderConfig.from_env()
GROQ_TIMEOUT = httpx.Timeout(35.0, connect=5.0)


def text_payload(config, messages, max_tokens, temperature=None, *, stream=False):
    payload = {"model": config.text_model, "messages": messages,
               "max_tokens": min(max_tokens, 2048) if config.demo else max_tokens}
    if temperature is not None:
        payload["temperature"] = temperature
    if stream:
        payload["stream"] = True
    return payload


def complete(config, messages, max_tokens=2048, temperature=None):
    with httpx.Client(timeout=GROQ_TIMEOUT) as client:
        response = client.post(config.base_url + "/chat/completions", headers=config.headers(),
                               json=text_payload(config, messages, max_tokens, temperature))
        response.raise_for_status()
        choice = response.json()["choices"][0]
        content = choice["message"].get("content") or ""
        if not content.strip():
            raise ProviderResponseError("empty_reply", choice.get("finish_reason"))
        return content


async def stream(config, messages, max_tokens=2048):
    received_content = False
    completed = False
    async with httpx.AsyncClient(timeout=GROQ_TIMEOUT) as client:
        async with client.stream("POST", config.base_url + "/chat/completions",
                                 headers=config.headers(),
                                 json=text_payload(config, messages, max_tokens, stream=True)) as response:
            response.raise_for_status()
            async for line in response.aiter_lines():
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    completed = True
                    break
                chunk = json.loads(data)
                if chunk.get("error"):
                    raise ProviderResponseError("stream_error")
                choices = chunk.get("choices") or []
                if choices:
                    content = choices[0].get("delta", {}).get("content")
                    if content:
                        received_content = True
                        yield content
            if not completed or not received_content:
                raise ProviderResponseError("empty_stream" if completed else "interrupted_stream")


def audio_upload(content_type):
    mime = (content_type or "audio/webm").split(";", 1)[0].strip().lower()
    extensions = {"audio/webm": "webm", "video/webm": "webm", "audio/mp4": "m4a",
                  "video/mp4": "mp4", "audio/ogg": "ogg", "audio/wav": "wav",
                  "audio/x-wav": "wav", "audio/mpeg": "mp3"}
    if mime not in extensions:
        raise ValueError("Unsupported microphone audio format. Please try another browser.")
    return "audio." + extensions[mime], mime


async def transcribe(config, audio, content_type):
    filename, mime = audio_upload(content_type)
    headers = config.headers()
    headers.pop("Content-Type")  # httpx must supply the multipart boundary.
    async with httpx.AsyncClient(timeout=GROQ_TIMEOUT) as client:
        response = await client.post(config.base_url + "/audio/transcriptions", headers=headers,
                                     files={"file": (filename, audio, mime)},
                                     data={"model": config.stt_model, "response_format": "json"})
        response.raise_for_status()
        text = (response.json().get("text") or "").strip()
        if not text:
            raise ProviderResponseError("empty_transcript")
        return text
