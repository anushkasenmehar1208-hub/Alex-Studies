#!/usr/bin/env python3
"""
Production ASGI server for Alex Studies.

This script starts the backend directly using Uvicorn, avoiding `reflex run`
which triggers frontend compilation at runtime.

The frontend is pre-compiled during Docker build via:
    reflex export --frontend-only --no-zip --env prod

This script:
1. Creates .web/nocompile marker file (the standard Reflex way to skip compilation)
2. Sets REFLEX_WEB_WORKDIR to point to pre-compiled frontend
3. Sets REFLEX_ENV_MODE=PROD
4. Imports the app module and gets the ASGI app (app._api)
5. Runs the ASGI app with Uvicorn on 0.0.0.0:$PORT
"""

import os
import sys
from pathlib import Path

# Detect if running in Docker (has /app) or locally
IN_DOCKER = Path("/app").exists()
WEB_DIR = Path("/app/.web") if IN_DOCKER else Path("/tmp/test_web")

# Must be set BEFORE importing reflex or the app module
os.environ.setdefault("REFLEX_WEB_WORKDIR", str(WEB_DIR))
os.environ.setdefault("REFLEX_ENV_MODE", "PROD")

# Ensure the nocompile marker exists (standard Reflex way to skip compilation)
nocompile_path = WEB_DIR / "nocompile"
nocompile_path.parent.mkdir(parents=True, exist_ok=True)
nocompile_path.write_text("")

# Also ensure backend markers exist
backend_dir = WEB_DIR / "backend"
backend_dir.mkdir(parents=True, exist_ok=True)
(backend_dir / "stateful_pages.json").write_text("[]")
(backend_dir / "upload_is_used").write_text("false")

# Now import the app - compilation should be skipped due to nocompile file
import uvicorn
from uni_app.uni_app import api as asgi_app


def main():
    port = int(os.environ.get("PORT", "8080"))
    
    print(f"Starting production server on 0.0.0.0:{port}")
    print(f"Frontend: {WEB_DIR / 'build/client'}")
    print(f"Database: {'configured' if os.environ.get('DATABASE_URL') else 'NOT SET'}")
    print(f"Starting Uvicorn...")
    
    # Run with Uvicorn
    uvicorn.run(
        asgi_app,
        host="0.0.0.0",
        port=port,
        log_level="info",
        access_log=True,
    )


if __name__ == "__main__":
    main()