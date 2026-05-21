"""Run each test suite in a separate pytest process to avoid module name
collisions (every service has its own `app` package).

Usage: python tests/run_all.py [--cov]
"""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TEST_DIRS = ["tests/unit", "tests/auth", "tests/channel", "tests/message"]

want_cov = "--cov" in sys.argv

failed = []
combined_data = ROOT / ".coverage"
if combined_data.exists():
    combined_data.unlink()

for d in TEST_DIRS:
    print("\n" + "=" * 72)
    print(f"  RUNNING: {d}")
    print("=" * 72)
    cmd = [sys.executable, "-m", "pytest", d]
    if want_cov:
        # Append coverage data to a single file across runs
        cmd = [
            sys.executable, "-m", "pytest",
            "--cov", "--cov-append", "--cov-report=", d,
        ]
    result = subprocess.run(cmd, cwd=ROOT)
    if result.returncode != 0:
        failed.append(d)

if want_cov:
    print("\n" + "=" * 72)
    print("  COMBINED COVERAGE REPORT")
    print("=" * 72)
    subprocess.run([sys.executable, "-m", "coverage", "report", "-m"], cwd=ROOT)
    subprocess.run([sys.executable, "-m", "coverage", "html"], cwd=ROOT)

print("\n" + "=" * 72)
if failed:
    print(f"  FAILED suites: {failed}")
    sys.exit(1)
else:
    print("  ALL SUITES PASSED")
