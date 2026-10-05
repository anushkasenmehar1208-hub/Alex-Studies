"""Test response serialization without initializing Reflex or the database."""
import ast
import asyncio
from pathlib import Path
import unittest

import h11
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response


class SecurityHeaderTests(unittest.TestCase):
    def test_security_headers_serialize_for_html_and_health_responses(self):
        source = Path(__file__).parents[1] / "uni_app" / "uni_app.py"
        tree = ast.parse(source.read_text())
        middleware = next(node for node in tree.body
                          if isinstance(node, ast.ClassDef)
                          and node.name == "SecurityHeadersMiddleware")
        namespace = {"BaseHTTPMiddleware": BaseHTTPMiddleware}
        exec(compile(ast.Module(body=[middleware], type_ignores=[]), str(source), "exec"), namespace)
        instance = namespace["SecurityHeadersMiddleware"](None)
        for media_type in ("text/html", "application/json"):
            with self.subTest(media_type=media_type):
                response = Response("ok", media_type=media_type)

                async def call_next(request):
                    return response

                result = asyncio.run(instance.dispatch(None, call_next))
                connection = h11.Connection(h11.SERVER)
                wire = connection.send(h11.Response(status_code=200, headers=result.raw_headers))
                self.assertIn(b"content-security-policy:", wire.lower())
                self.assertIn("worker-src 'self' blob:;", result.headers["content-security-policy"])


if __name__ == "__main__":
    unittest.main()
