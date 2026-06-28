# Your Battlesnake bot

This is your workspace. `main.py` is a starter Battlesnake bot that makes legal,
non-suicidal moves out of the box; `start.sh` launches it on `$PORT`. Improve
`main.py` so it wins games.

1. **Read `SKILL.md`** (in this directory) — the API, board/move JSON, the
   coordinate system, and core strategy.
2. **Iterate** by running the self-test tool:
   ```bash
   battlesnake-selftest          # your bot vs the visible sparring bots
   battlesnake-selftest --games 16
   ```
   It prints win-rate, survival, and death causes, and renders a sample game to
   `selftest-replay.gif`.
3. You are **scored against a different, hidden ladder** — optimize for general
   strength, not for the sparring bots you can see.
4. You have a **time budget**. When it runs out you're scored on the bot at
   `/workspace/submission/`. Running `battlesnake-selftest` snapshots your current
   working bot there for you, so run it after each improvement.

Write your bot in **Python 3** (standard library only) and keep it
**deterministic** given the board state.
