#!/bin/sh
set -e

if [ -f "/app/alembic.ini" ]; then
    # Print which DB we're targeting — single source of truth at startup
    echo "[entrypoint] SERVICE=${SERVICE_NAME:-?}  POSTGRES_DB=${POSTGRES_DB:-(unset!)}"
    if [ -z "${POSTGRES_DB}" ]; then
        echo "[entrypoint] FATAL: POSTGRES_DB env var is not set. Refusing to start." >&2
        exit 1
    fi

    echo "[entrypoint] Running 'alembic upgrade head' against database '${POSTGRES_DB}'..."
    for i in 1 2 3 4 5; do
        if alembic upgrade head; then
            echo "[entrypoint] Migrations applied."
            # Show what got created — fail-loud diagnostic
            echo "[entrypoint] Tables in '${POSTGRES_DB}':"
            python -c "
import asyncio
from app.config import get_settings
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy import text

async def show():
    s = get_settings()
    e = create_async_engine(s.postgres_dsn())
    async with e.connect() as c:
        r = await c.execute(text(\"SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename\"))
        rows = [row[0] for row in r]
        print('  ' + ('\n  '.join(rows) if rows else '(none)'))
    await e.dispose()

asyncio.run(show())
" || echo "  (could not list tables — continuing anyway)"
            break
        fi
        echo "[entrypoint] Migration attempt $i failed, retrying in 3s..."
        sleep 3
        if [ "$i" = "5" ]; then
            echo "[entrypoint] FATAL: migrations failed after 5 attempts." >&2
            exit 1
        fi
    done
fi

echo "[entrypoint] Starting application..."
exec "$@"
