"""Tests for the calculator."""

from main import add_numbers


def test_add_numbers():
    """Test that add_numbers works correctly."""
    assert add_numbers(1, 2) == 3
    assert add_numbers(0, 0) == 0
    assert add_numbers(-1, 1) == 0
    assert add_numbers(100, 200) == 300


def test_add_negative_numbers():
    """Test adding negative numbers."""
    assert add_numbers(-5, -3) == -8
    assert add_numbers(-10, 5) == -5
