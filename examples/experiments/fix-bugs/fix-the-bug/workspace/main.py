#!/usr/bin/env python3
"""
A simple calculator CLI tool with a bug.
"""

import sys


def add_numbers(a, b):
    """Add two numbers together."""
    # Bug: trying to add string and int
    return a + b


def parse_args(args):
    """Parse command line arguments."""
    if len(args) < 3:
        print("Usage: python main.py <num1> <num2>")
        sys.exit(1)

    return args[1], int(args[2])


def main():
    """Main entry point."""
    a, b = parse_args(sys.argv)
    result = add_numbers(a, b)
    print(f"Result: {result}")


if __name__ == "__main__":
    main()
