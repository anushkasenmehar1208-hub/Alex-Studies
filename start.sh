#!/bin/sh
set -e

APP_PORT="${PORT:-8080}"

echo "Starting Reflex app on port $APP_PORT (single-port mode, precompiled frontend)"
echo "APP_BASE_URL=${APP_BASE_URL:-not set}"
echo "DATABASE_URL=${DATABASE_URL:+set}"

# Skip frontend compilation at runtime since it was pre-compiled during Docker build
export REFLEX_SKIP_COMPILE=true

reflex run --env prod --single-port --backend-host 0.0.0.0 --frontend-port "$APP_PORT" --backend-port "$APP_PORT"