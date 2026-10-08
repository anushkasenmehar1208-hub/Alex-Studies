"""Exercise actual HTTP helpers and extracted handlers without a database/server."""
import ast
import asyncio
import json
import logging
import os
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import httpx
from starlette.requests import Request
from starlette.responses import JSONResponse, StreamingResponse

from uni_app import ai_provider


ROOT = Path(__file__).parents[1]
DEMO = ai_provider.ProviderConfig(True, "groq", "test-key", "https://api.groq.com/openai/v1",
                                  "openai/gpt-oss-20b", "whisper-large-v3-turbo")


def handlers(config=DEMO):
    names = {"_openrouter_complete", "_openrouter_stream_async", "_openrouter_llm_ready",
             "_openrouter_generate_with_fallback", "_openai_generate_image_bytes",
             "_openrouter_read_image", "_openrouter_generate_svg", "_alex_fish_tts_wav_bytes",
             "_alex_voice_tts_audio_b64", "alex_voice_stt", "_voice_language_response_meta",
             "alex_voice_api", "alex_voice_stream", "alex_voice_intro"}
    tree = ast.parse((ROOT / "uni_app/uni_app.py").read_text())
    selected = [n for n in tree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name in names]
    ns = {"AI_CONFIG": config, "ai_provider": ai_provider, "Any": object, "Request": Request,
          "JSONResponse": JSONResponse, "StreamingResponse": StreamingResponse,
          "httpx": httpx, "asyncio": asyncio, "json": json,
          "logger": logging.getLogger("demo-test"), "OPENAI_API_KEY": "paid-openai",
          "OPENROUTER_API_KEY": "paid-openrouter", "FISH_AUDIO_API_KEY": "paid-fish",
          "OPENROUTER_DRAW_MODEL": "paid-draw", "OPENROUTER_AUX_FALLBACK_MODEL": "paid-fallback",
          "OPENROUTER_VOICE_MODEL": "paid-voice", "OPENAI_STT_MODEL": "gpt-4o-mini-transcribe",
          "_LLMTextResponse": lambda text: SimpleNamespace(text=text),
          "_prune_stale_voice_sessions": lambda: None, "_voice_request_uid": lambda req: 1,
          "_is_valid_voice_key": lambda key: True, "_apply_voice_language_directive_to_ctx": lambda *a: None,
          "_alex_voice_trim_history": lambda ctx, history: history,
          "_strip_think_tags": lambda text: text, "_polish_llm_text_for_voice_speech": lambda text: text,
          "_voice_display_markdown": lambda text: text, "_markdown_to_safe_html_for_voice": lambda text: text,
          "_prepare_tts_text": lambda text, **kw: text, "_is_rate_limit_text": lambda text: False,
          "RATE_LIMIT_UI_MESSAGE": "rate limit", "GENERIC_ERROR_UI_MESSAGE": "error",
          "_alex_voice_first_tts_prefix": lambda text: None,
          "LANGUAGE_AUTO": "Auto", "VOICE_LANGUAGE_SAME_AS_REPLY": "Same as reply",
          "_normalize_voice_language": lambda value: value or "English",
          "_normalize_reply_language": lambda value: value or "Auto",
          "_voice_language_from_ctx": lambda ctx: "English",
          "_alex_voice_sessions": {"test-session": {"uid": 1, "system": "tutor", "history": []}}}
    exec(compile(ast.Module(body=selected, type_ignores=[]), "handlers", "exec"), ns)
    return ns


def request(body, content_type="application/json"):
    sent = False
    async def receive():
        nonlocal sent
        if not sent:
            sent = True
            return {"type": "http.request", "body": body, "more_body": False}
        return {"type": "http.disconnect"}
    return Request({"type": "http", "method": "POST", "path": "/", "query_string": b"",
                    "headers": [(b"content-type", content_type.encode())]}, receive)


class DemoProviderTests(unittest.TestCase):
    def test_chat_escalation_calls_match_router_interface_and_block_demo_retries(self):
        from uni_app import alex_routing
        import inspect
        tree = ast.parse((ROOT / "uni_app/uni_app.py").read_text())
        calls = [node for node in ast.walk(tree) if isinstance(node, ast.Call)
                 and isinstance(node.func, ast.Attribute) and node.func.attr == "next_escalation"]
        self.assertTrue(calls)
        values = {"teacher_m": "teacher", "reasoning_m": "reasoning", "premium_m": "premium",
                  "route": {}, "premium_ok": False}
        with patch.object(alex_routing, "AI_CONFIG", DEMO):
            for call in calls:
                kwargs = {keyword.arg: values.get(keyword.arg) for keyword in call.keywords}
                inspect.signature(alex_routing.next_escalation).bind("groq-model", **kwargs)
                self.assertIsNone(alex_routing.next_escalation("groq-model", **kwargs))

    def test_selection_is_reversible_and_demo_forces_groq(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(ai_provider.ProviderConfig.from_env().provider, "openrouter")
        with patch.dict(os.environ, {"ALEX_DEMO_FREE_MODE": "true", "ALEX_TEXT_PROVIDER": "openrouter"}, clear=True):
            c = ai_provider.ProviderConfig.from_env()
            self.assertTrue(c.blocks_paid)
            self.assertEqual(c.provider, "groq")
        with patch.dict(os.environ, {"ALEX_TEXT_PROVIDER": "groq"}, clear=True):
            self.assertFalse(ai_provider.ProviderConfig.from_env().blocks_paid)
        with patch.dict(os.environ, {"ALEX_DEMO_FREE_MODE": "true", "GROQ_BASE_URL": "https://openrouter.ai/api/v1"}, clear=True):
            with self.assertRaises(ValueError):
                ai_provider.ProviderConfig.from_env()

    def test_missing_groq_key_does_not_use_configured_paid_keys(self):
        from dataclasses import replace
        ns = handlers(replace(DEMO, api_key=""))
        self.assertFalse(ns["_openrouter_llm_ready"]())
        with patch.object(httpx, "Client", side_effect=AssertionError("No HTTP with missing key")):
            response = ns["_openrouter_complete"]("paid", [], 100)
            self.assertIn("GROQ_API_KEY", response.text)
        response = asyncio.run(ns["alex_voice_stt"](request(b"x" * 100)))
        self.assertEqual(response.status_code, 503)

    def test_completion_failure_does_not_retry_auxiliary_paid_model(self):
        ns = handlers()
        ns["_openrouter_generate_user_prompt"] = lambda model, contents, max_tokens: ns["_openrouter_complete"](model, [{"role": "user", "content": contents}], max_tokens)
        with patch.object(ai_provider, "complete", side_effect=httpx.ReadTimeout("provider timeout")) as complete:
            response = ns["_openrouter_generate_with_fallback"]("paid", "hello", 100)
            self.assertEqual(response.text, ai_provider.DEMO_ERROR)
            complete.assert_called_once()

    def test_video_generation_and_model_escalation_are_blocked(self):
        from uni_app import alex_routing
        with patch.object(alex_routing, "AI_CONFIG", DEMO):
            self.assertIsNone(alex_routing.next_escalation("teacher", teacher_m="teacher", reasoning_m="reason",
                                                        premium_m="premium", route={}, premium_ok=True))
        # Execute the actual service guard without loading Manim or starting jobs.
        from fastapi import HTTPException
        tree = ast.parse((ROOT / "alex_video_service/main.py").read_text())
        node = next(n for n in tree.body if isinstance(n, ast.AsyncFunctionDef) and n.name == "render")
        node.decorator_list = []
        ns = {"os": os, "HTTPException": HTTPException, "RenderRequest": object, "RenderResponse": object}
        exec(compile(ast.Module(body=[node], type_ignores=[]), "video_guard", "exec"), ns)
        with patch.dict(os.environ, {"ALEX_DEMO_FREE_MODE": "true"}):
            with self.assertRaises(HTTPException) as error:
                asyncio.run(ns["render"](object()))
            self.assertEqual(error.exception.status_code, 403)

    def test_chat_selects_single_groq_model_without_router_or_manual_override(self):
        from uni_app import alex_routing
        tree = ast.parse((ROOT / "uni_app/uni_app.py").read_text())
        app_state = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "AppState")
        resolve = next(n for n in app_state.body if isinstance(n, ast.AsyncFunctionDef) and n.name == "_alex_resolve_chat_model")
        ns = {"AI_CONFIG": DEMO, "alex_routing": alex_routing, "Any": object}
        exec(compile(ast.Module(body=[resolve], type_ignores=[]), "resolve", "exec"), ns)
        model, mode, route = asyncio.run(ns["_alex_resolve_chat_model"](object(), "Explain calculus", 1))
        self.assertEqual(model, DEMO.text_model)
        self.assertEqual(mode, "core")
        self.assertEqual(route["provider"], "groq")
        self.assertNotIn("manual_model_key", route)

    def test_intro_is_readable_and_uses_browser_tts_without_server_audio(self):
        ns = handlers()
        with patch.object(httpx, "AsyncClient", side_effect=AssertionError("No server TTS")):
            response = asyncio.run(ns["alex_voice_intro"](request(b"")))
        body = json.loads(response.body)
        self.assertIn("Welcome", body["text"])
        self.assertEqual(body["tts_mode"], "browser")
        self.assertEqual(body["audio_b64"], "")

    def test_groq_completion_preserves_messages_and_never_uses_requested_paid_model(self):
        calls = []
        def respond(req):
            calls.append(req)
            return httpx.Response(200, json={"choices": [{"message": {"content": "Hello"}}]})
        real = httpx.Client
        with patch.object(ai_provider.httpx, "Client", side_effect=lambda **kw: real(transport=httpx.MockTransport(respond), **kw)):
            ns = handlers()
            messages = [{"role": "system", "content": "tutor"}, {"role": "user", "content": "context"}]
            self.assertEqual(ns["_openrouter_complete"]("paid-model", messages, 8192).text, "Hello")
        payload = json.loads(calls[0].content)
        self.assertEqual(str(calls[0].url), DEMO.base_url + "/chat/completions")
        self.assertEqual(payload["model"], DEMO.text_model)
        self.assertEqual(payload["messages"], messages)
        self.assertEqual(payload["max_tokens"], 2048)
        self.assertEqual(calls[0].headers["authorization"], "Bearer test-key")

    def test_streaming_and_failure_have_no_paid_fallback(self):
        calls = []
        def respond(req):
            calls.append(req)
            return httpx.Response(200, text='data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: [DONE]\n\n')
        async def collect(ns):
            return [p async for p in ns["_openrouter_stream_async"]("paid-model", [{"role": "user", "content": "hi"}])]
        real = httpx.AsyncClient
        with patch.object(ai_provider.httpx, "AsyncClient", side_effect=lambda **kw: real(transport=httpx.MockTransport(respond), **kw)):
            self.assertEqual(asyncio.run(collect(handlers())), ["Hello"])
        self.assertTrue(json.loads(calls[0].content)["stream"])
        calls.clear()
        def fail(req):
            calls.append(req)
            return httpx.Response(429, json={"error": "quota"})
        with patch.object(ai_provider.httpx, "AsyncClient", side_effect=lambda **kw: real(transport=httpx.MockTransport(fail), **kw)):
            self.assertEqual(asyncio.run(collect(handlers())), [ai_provider.DEMO_ERROR])
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0].url.host, "api.groq.com")

    def test_stt_multipart_uses_groq_model_and_correct_filename(self):
        calls = []
        def respond(req):
            calls.append(req)
            return httpx.Response(200, json={"text": " spoken question "})
        real = httpx.AsyncClient
        for mime, filename in [("audio/webm;codecs=opus", "audio.webm"), ("audio/mp4", "audio.m4a"), ("audio/ogg", "audio.ogg")]:
            with self.subTest(mime=mime), patch.object(ai_provider.httpx, "AsyncClient", side_effect=lambda **kw: real(transport=httpx.MockTransport(respond), **kw)):
                response = asyncio.run(handlers()["alex_voice_stt"](request(b"a" * 100, mime)))
                self.assertEqual(json.loads(response.body)["text"], "spoken question")
                req = calls[-1]
                self.assertEqual(str(req.url), DEMO.base_url + "/audio/transcriptions")
                self.assertIn(filename.encode(), req.content)
                self.assertIn(b"whisper-large-v3-turbo", req.content)
                self.assertIn("boundary=", req.headers["content-type"])

    def test_stt_failure_and_unsupported_audio_return_clear_errors(self):
        ns = handlers()
        response = asyncio.run(ns["alex_voice_stt"](request(b"x" * 100, "text/plain")))
        self.assertEqual(response.status_code, 415)
        with patch.object(ai_provider, "transcribe", side_effect=httpx.ReadTimeout("timeout")) as transcribe:
            response = asyncio.run(ns["alex_voice_stt"](request(b"x" * 100, "audio/mp4")))
            self.assertEqual(response.status_code, 502)
            self.assertEqual(json.loads(response.body)["error"], ai_provider.DEMO_ERROR)
            transcribe.assert_called_once()

    def test_paid_image_vision_and_tts_are_blocked_before_http(self):
        ns = handlers()
        with patch.object(httpx, "Client", side_effect=AssertionError("paid HTTP")), patch.object(httpx, "AsyncClient", side_effect=AssertionError("paid HTTP")):
            self.assertIn("disabled", ns["_openai_generate_image_bytes"]("image")[2])
            self.assertIn("disabled", ns["_openrouter_read_image"](b"image", "image/png", "read"))
            self.assertEqual(ns["_openrouter_generate_svg"]("topic"), "")
            self.assertIsNone(asyncio.run(ns["_alex_fish_tts_wav_bytes"]("hello")))
            self.assertEqual(asyncio.run(ns["_alex_voice_tts_audio_b64"]("hello")), "")

    def test_voice_json_and_sse_return_text_with_browser_tts(self):
        real = httpx.AsyncClient
        def respond(req):
            return httpx.Response(200, text='data: {"choices":[{"delta":{"content":"A short explanation."}}]}\n\ndata: [DONE]\n\n')
        async def exercise(name):
            ns = handlers()
            result = await ns[name](request(json.dumps({"transcript": "explain", "voice_key": "test-session"}).encode()))
            if name == "alex_voice_stream":
                parts = [part async for part in result.body_iterator]
                return json.loads(parts[-1].split("data: ", 1)[1])
            return json.loads(result.body)
        with patch.object(ai_provider.httpx, "AsyncClient", side_effect=lambda **kw: real(transport=httpx.MockTransport(respond), **kw)):
            for name in ("alex_voice_api", "alex_voice_stream"):
                result = asyncio.run(exercise(name))
                self.assertEqual(result["text"], "A short explanation.")
                self.assertEqual(result["tts_mode"], "browser")
                self.assertFalse(result.get("audio_b64"))


if __name__ == "__main__":
    unittest.main()
