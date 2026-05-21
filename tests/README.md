# Tests

Pytest suite for the messenger MVP. Runs **without Docker** — PostgreSQL is
replaced with in-memory SQLite (`aiosqlite`), MongoDB with `mongomock-motor`,
Redis with `fakeredis`.

## Why a runner script

All three Postgres-backed services share the package name `app` (each has its
own `services/<name>/app/...`). If we let pytest collect all tests in one
process, the second service's `app` import would silently return the first
service's already-cached module, and routes would not be registered, leading to
404s everywhere.

The fix is dead simple: run each test directory in a **separate** pytest
process. The runner script does that and (optionally) merges coverage.

## Layout

```
tests/
├── unit/         # pure functions — permissions, JWT, security
├── auth/         # auth-service HTTP routes
├── channel/      # channel-service HTTP routes
├── message/      # message-service HTTP routes
└── run_all.py    # orchestrates the above
```

## How to run

From the project root (where this README's parent dir is):

```bash
# 1. Create venv and install test deps
python -m venv .venv
# macOS/Linux:
source .venv/bin/activate
# Windows PowerShell:
.venv\Scripts\Activate.ps1

pip install -r tests/requirements.txt

# 2. Run everything
python tests/run_all.py

# 3. Same, with coverage
python tests/run_all.py --cov
```

You can also run individual suites:

```bash
pytest tests/unit
pytest tests/auth
pytest tests/channel
pytest tests/message
```

Single test:
```bash
pytest tests/auth/test_auth.py::test_refresh_token_produces_new_pair
```

## Expected output (snippet)

```
========================================================================
  RUNNING: tests/unit
========================================================================
tests/unit/test_permissions.py::test_default_member_has_basic_perms
[test] default_member bitmask = 1110000011
PASSED
...
========================================================================
  RUNNING: tests/auth
========================================================================
tests/auth/test_auth.py::test_register_creates_account
[test] POST /api/auth/register
  status=201
PASSED
...
========================================================================
  COMBINED COVERAGE REPORT
========================================================================
Name                                                Stmts   Miss   Cover
-----------------------------------------------------------------------
libs/shared-py/shared/permissions.py                   18      0   100.0%
libs/shared-py/shared/jwt_utils.py                     22      1    95.5%
services/auth-service/app/security.py                  18      1    94.4%
services/auth-service/app/routes.py                    85      8    90.6%
services/channel-service/app/routes.py                190     22    88.4%
services/message-service/app/routes.py                 47      4    91.5%
-----------------------------------------------------------------------
TOTAL                                                 380     36    90.5%
```

Coverage is measured only for **business-logic modules** (see `.coveragerc`).
Plumbing like `db.py`, `config.py`, `main.py`, `__init__.py`, and Alembic
migrations is excluded from the scope.
