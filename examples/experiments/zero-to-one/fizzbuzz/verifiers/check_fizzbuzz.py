#!/usr/bin/env python3
"""
Verifier for FizzBuzz experiment.
Checks that fizzbuzz.py produces correct output for 1-100.
"""

import subprocess
import sys
import os

EXPECTED = []
for i in range(1, 101):
    if i % 15 == 0:
        EXPECTED.append("FizzBuzz")
    elif i % 3 == 0:
        EXPECTED.append("Fizz")
    elif i % 5 == 0:
        EXPECTED.append("Buzz")
    else:
        EXPECTED.append(str(i))


def main():
    workspace = "/workspace"
    script = os.path.join(workspace, "fizzbuzz.py")

    if not os.path.exists(script):
        print("FAIL: fizzbuzz.py not found", file=sys.stderr)
        sys.exit(1)

    result = subprocess.run(
        ["python", script],
        capture_output=True,
        text=True,
        timeout=10,
        cwd=workspace,
    )

    if result.returncode != 0:
        print(f"FAIL: fizzbuzz.py exited with code {result.returncode}", file=sys.stderr)
        print(result.stderr, file=sys.stderr)
        sys.exit(1)

    lines = [line.strip() for line in result.stdout.strip().split("\n") if line.strip()]

    if len(lines) != 100:
        print(f"FAIL: Expected 100 lines, got {len(lines)}", file=sys.stderr)
        sys.exit(1)

    errors = []
    for i, (got, expected) in enumerate(zip(lines, EXPECTED), 1):
        if got != expected:
            errors.append(f"  Line {i}: expected '{expected}', got '{got}'")

    if errors:
        print(f"FAIL: {len(errors)} incorrect values:", file=sys.stderr)
        for e in errors[:10]:
            print(e, file=sys.stderr)
        if len(errors) > 10:
            print(f"  ... and {len(errors) - 10} more", file=sys.stderr)
        sys.exit(1)

    print("All 100 values correct")
    sys.exit(0)


if __name__ == "__main__":
    main()
