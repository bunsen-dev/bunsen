#!/usr/bin/env python3
"""
Echo Agent - A simple test agent that echoes tasks.
"""

import sys


def main():
    if len(sys.argv) < 2:
        print("Usage: python main.py <task>")
        sys.exit(1)

    task = sys.argv[1]

    print("=" * 60)
    print("Echo Agent")
    print("=" * 60)
    print()
    print("Task received:")
    print("-" * 40)
    print(task)
    print("-" * 40)
    print()
    print("This is a test agent that simply echoes the task.")
    print("No AI calls are made.")
    print()
    print("Echo Agent completed successfully")


if __name__ == "__main__":
    main()
