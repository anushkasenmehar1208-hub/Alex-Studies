#!/bin/sh
set -e

APP_PORT="${PORT:-8080}"

echo "Starting production server on 0.0.0.0:$APP_PORT"
echo "APP_BASE_URL=${APP_BASE_URL:-not set}"
echo "DATABASE_URL=${DATABASE_URL:+set}"
echo "Frontend: /app/.web/build/client"

# Verify pre-compiled assets exist
ls -la /app/.web/ 2>/dev/null || echo "WARNING: /app/.web/ missing"
ls -la /app/.web/backend/ 2>/dev/null || echo "WARNING: backend dir missing"
ls -la /app/.web/build/client/ 2>/dev/null || echo "WARNING: frontend build missing"

# Set env vars BEFORE exec (must use __REFLEX_SKIP_COMPILE with double underscore)
export __REFLEX_SKIP_COMPILE=true
export REFLEX_WEB_WORKDIR=/app/.web

exec python3 production_server.py