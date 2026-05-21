"""Conftest for unit tests — only needs shared-py lib in path."""
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "libs" / "shared-py"))
sys.path.insert(0, str(ROOT / "services" / "auth-service"))
