#!/usr/bin/env bash
# Authoritative scoring run + the "not bankrupt" gate.
#
# This is the first (gate) criterion. It re-runs the agent's bot from the pinned
# seed in this isolated scorer container — independent of anything the agent's own
# process did — and reads metrics from authoritative game state via the baked
# reporter. The resulting /tmp/openttd-score/metrics.json is read by the cheap
# per-metric criteria that follow (the scorer container is shared across criteria).
#
# Last-working fallback: if the agent's FINAL bot fails the gate (e.g. an
# onTimeout:score run caught it mid-edit/broken), but the agent had a working bot
# during playtest, we score that checkpoint instead — an unfinished final tweak
# can't drag the score below a version the agent already had working.
#
# Gate score: 1.0 if a bot (final or last-working checkpoint) survives, else 0.
set -euo pipefail

OUT=/tmp/openttd-score
mkdir -p "$OUT"
FINAL_AI="${OPENTTD_AI_DIR:-/workspace/ai/StarterAI}"
CKPT="${BUNSEN_WORKSPACE_DIR:-/workspace}/.openttd/last-good/StarterAI"

run_sim() {  # $1 = AI package dir to score (into $OUT)
  OPENTTD_AI_DIR="$1" OPENTTD_OUT="$OUT" python3 /opt/bunsen/run_openttd.py || true
}

# Seed/horizon/map/climate come from the experiment env, falling back to harness defaults.
run_sim "$FINAL_AI"
USED_CHECKPOINT=0
NB=$(python3 -c "import json;print(json.load(open('$OUT/metrics.json')).get('not_bankrupt',0))" 2>/dev/null || echo 0)
if [ "$NB" != "1" ] && [ -f "$CKPT/info.nut" ]; then
  echo "final bot failed the gate; scoring the agent's last-working checkpoint instead"
  run_sim "$CKPT"
  USED_CHECKPOINT=1
fi

USED_CHECKPOINT="$USED_CHECKPOINT" python3 - "$OUT" <<'PY'
import json, os, shutil, sys
out = sys.argv[1]
used_ckpt = os.environ.get("USED_CHECKPOINT") == "1"
try:
    m = json.load(open(os.path.join(out, "metrics.json")))
except Exception:
    m = {"not_bankrupt": 0, "load_failed": True}

score = 1 if m.get("not_bankrupt") else 0
if score:
    summary = ("Company survived to %s — rating %s/1000, value %s, cargo %s"
               % (m.get("final_year"), m.get("rating"), m.get("company_value"),
                  m.get("cargo_delivered")))
    if used_ckpt:
        summary = "[scored last-working checkpoint; final workspace was broken/mid-edit] " + summary
else:
    summary = ("GATE FAILED: bot failed to compile/register"
               if m.get("load_failed") else
               "GATE FAILED: company went bankrupt or never closed a quarter")

result = {"score": score, "summary": summary, "artifacts": []}
scorer_out = os.environ.get("BUNSEN_SCORER_OUTPUT", out)
for fn, mt in (("final.sav", "application/octet-stream"),
               ("metrics.json", "application/json"),
               ("openttd.log", "text/plain")):
    src = os.path.join(out, fn)
    if os.path.isfile(src):
        shutil.copyfile(src, os.path.join(scorer_out, fn))
        result["artifacts"].append({"path": fn, "mediaType": mt})

with open(os.environ["BUNSEN_EVAL_RESULT"], "w") as f:
    json.dump(result, f)
print(summary)
PY
