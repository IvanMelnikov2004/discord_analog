"""Distributed sliding-window rate limiter.

Backed by Redis sorted sets — works across multiple message-service
replicas because the state lives in Redis, not in process memory.

Usage:
    from app.ratelimit import enforce_message_limit
    retry_after = await enforce_message_limit(user_id, scope)
    if retry_after is not None:
        raise HTTPException(429, "Too many messages", headers=...)

Two windows are enforced simultaneously:
  - short (anti-flood):  5 messages / 5 seconds
  - long  (anti-spam):  30 messages / minute
Defaults come from config; both are env-overridable.
"""
from __future__ import annotations

import time
import uuid

from app.config import get_settings
from app.db import redis_pub

_settings = get_settings()


async def _check_window(
    user_id: str,
    scope: str,
    window_seconds: int,
    max_events: int,
) -> float | None:
    """Return seconds-until-allowed if rate-limited, else None.

    Implementation: each (user, scope, window) maps to a Redis ZSET keyed by
    timestamps. We drop entries older than `now - window`, count what's left,
    and either bump or reject.
    """
    key = f"ratelimit:{user_id}:{scope}:{window_seconds}"
    now = time.time()
    cutoff = now - window_seconds

    # Atomic pipeline so the eviction + count happens in one round-trip,
    # avoiding races between concurrent requests.
    pipe = redis_pub.pipeline()
    pipe.zremrangebyscore(key, 0, cutoff)
    pipe.zcard(key)
    _, count = await pipe.execute()

    if count >= max_events:
        # Find when the OLDEST in-window event will expire — that's the
        # earliest moment the user can send again. zrange with WITHSCORES
        # returns [(member, score), ...] sorted ascending.
        oldest = await redis_pub.zrange(key, 0, 0, withscores=True)
        if oldest:
            _, oldest_ts = oldest[0]
            return max(0.1, (oldest_ts + window_seconds) - now)
        return float(window_seconds)

    # Under limit — record this event and set TTL so abandoned keys don't
    # linger in Redis. The TTL must be at least the window size.
    member = f"{now}:{uuid.uuid4().hex[:8]}"
    pipe = redis_pub.pipeline()
    pipe.zadd(key, {member: now})
    pipe.expire(key, window_seconds + 1)
    await pipe.execute()
    return None


async def enforce_message_limit(user_id: str, scope: str) -> float | None:
    """Check both anti-flood and anti-spam windows for one user+scope.

    `scope` is a free-form bucket identifier — typically `room:<uuid>` or
    `dm:<uuid>` so rate limits are per-conversation. Returns None on
    success, or a float number of seconds the caller should wait before
    retrying when limited (use the larger of the two if both fire).
    """
    short = await _check_window(
        user_id,
        scope,
        _settings.RATE_LIMIT_SHORT_WINDOW_SECONDS,
        _settings.RATE_LIMIT_SHORT_MAX,
    )
    long = await _check_window(
        user_id,
        scope,
        _settings.RATE_LIMIT_LONG_WINDOW_SECONDS,
        _settings.RATE_LIMIT_LONG_MAX,
    )
    # Both checks already wrote to Redis if they passed. If either fails we
    # surface the bigger wait. We don't roll back the passing window — over
    # a minute of activity this self-corrects, and rolling back races.
    if short is None and long is None:
        return None
    return max(short or 0, long or 0)
