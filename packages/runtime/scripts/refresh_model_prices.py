#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
"""
Refresh the vendored model-pricing snapshot used by the proxy cost estimator.

The proxy (`packages/runtime/src/proxy/ai_capture.py`) prices every captured AI
call from a checked-in JSON snapshot rather than a hand-maintained dict. This
script regenerates that snapshot from LiteLLM's community pricing dataset
(BerriAI/litellm, MIT) — the de-facto-standard source for per-model token
prices across Anthropic / OpenAI / Google.

Scope: the snapshot vendors **every native Anthropic / OpenAI / Google model**
LiteLLM tracks (token-priced), not just the models our example agents happen to
declare. Bunsen is a general-purpose runner — a user's agent can reference any
model — and the proxy only ever intercepts three hosts (api.anthropic.com,
api.openai.com, generativelanguage.googleapis.com), so "any model a user may
use" == any native model from those three providers. We deliberately exclude
cloud-routed variants (Bedrock / Azure / Vertex-Anthropic, etc.): those go to
hosts we don't capture and may carry different prices, and their model ids would
never appear in a captured trace anyway.

For Google we prefer LiteLLM's `gemini` provider (the AI-Studio API served by
generativelanguage.googleapis.com — exactly what we capture) over Vertex; their
prices are identical for shared models, and `gemini` covers more ids.

What it does:
  1. Fetches LiteLLM's `model_prices_and_context_window.json` (or reads a local
     copy via --source).
  2. Selects token-priced entries whose `litellm_provider` is one of our native
     providers, normalizes each key to its bare model id (strips routing
     prefixes like `gemini/`), de-dupes preferring the native-host source, and
     keeps only the cost fields the estimator consumes. The snapshot stays in
     LiteLLM's NATIVE per-token units and field names — a faithful, diffable
     slice of upstream. The proxy converts per-token -> per-1M at load.
  3. Errors loudly if a provider yields no models (a sign LiteLLM renamed a
     provider tag and the filter silently broke).

Usage:
    python3 packages/runtime/scripts/refresh_model_prices.py
    python3 packages/runtime/scripts/refresh_model_prices.py --source /tmp/litellm.json
    python3 packages/runtime/scripts/refresh_model_prices.py --ref v1.80.0 --check

Cadence: run deliberately when prices move or new models ship (and re-validate).
Safe to wire into a scheduled CI job (fetch + --check) so the snapshot doesn't
silently rot; the proxy itself never touches the network.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request

# Repo layout anchors (this file lives at packages/runtime/scripts/).
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.abspath(os.path.join(_SCRIPT_DIR, "..", "..", ".."))
_SNAPSHOT_PATH = os.path.join(
    _REPO_ROOT, "packages", "runtime", "src", "proxy", "model_prices.json"
)

# LiteLLM's pricing dataset. `{ref}` is a branch/tag/commit on BerriAI/litellm.
_LITELLM_URL_TEMPLATE = (
    "https://raw.githubusercontent.com/BerriAI/litellm/"
    "{ref}/model_prices_and_context_window.json"
)

# Bunsen provider tag -> ordered list of LiteLLM `litellm_provider` values that
# represent the NATIVE API for that provider (the hosts the proxy captures).
# Order = preference when the same bare model id appears under more than one:
# earlier wins. For Google we prefer `gemini` (AI Studio) over Vertex.
NATIVE_PROVIDERS = {
    "anthropic": ["anthropic"],
    "openai": ["openai", "text-completion-openai"],
    "google": ["gemini", "vertex_ai-language-models"],
}
# Flatten to litellm_provider -> (tag, preference_index).
_PROVIDER_RANK = {
    prov: (tag, i)
    for tag, provs in NATIVE_PROVIDERS.items()
    for i, prov in enumerate(provs)
}

# Each tag must yield at least this many models, else the refresh aborts — a
# guard against LiteLLM renaming a provider tag and silently emptying a provider.
_MIN_MODELS_PER_TAG = 5

# Only these LiteLLM fields are carried into the snapshot. Everything else
# (context windows, tiered/batch/flex/priority rates, search-context costs,
# modality flags) is dropped to keep the file small and the diffs readable.
_KEPT_FIELDS = (
    "litellm_provider",
    "input_cost_per_token",
    "output_cost_per_token",
    "cache_read_input_token_cost",
    "cache_creation_input_token_cost",
)


def load_litellm_dataset(source: str | None, ref: str) -> dict:
    """Load the LiteLLM dataset from a local path or the GitHub raw URL."""
    if source and os.path.isfile(source):
        with open(source, encoding="utf-8") as f:
            return json.load(f)
    url = source or _LITELLM_URL_TEMPLATE.format(ref=ref)
    print(f"Fetching LiteLLM dataset: {url}", file=sys.stderr)
    with urllib.request.urlopen(url, timeout=60) as resp:  # noqa: S310 (trusted URL)
        return json.loads(resp.read().decode("utf-8"))


def select_models(dataset: dict) -> dict:
    """Pick the native, token-priced Anthropic/OpenAI/Google models from the
    dataset, keyed by bare model id with only the cost fields we price on."""
    # bare_id -> (rank_tuple, key, tag) of the best (most-preferred) source.
    best: dict[str, tuple] = {}
    for key, entry in dataset.items():
        if not isinstance(entry, dict) or "input_cost_per_token" not in entry:
            continue
        rank_for = _PROVIDER_RANK.get(entry.get("litellm_provider"))
        if rank_for is None:
            continue
        tag, pref = rank_for
        bare = key.rsplit("/", 1)[-1]
        # Vertex's language-models bucket also holds non-Gemini legacy models
        # (bison/PaLM) that generativelanguage.googleapis.com never serves.
        if tag == "google" and entry["litellm_provider"] == "vertex_ai-language-models" \
                and not bare.startswith("gemini"):
            continue
        # Prefer: native-host provider (lower pref) > a no-prefix key > shorter key.
        rank = (pref, 0 if "/" not in key else 1, len(key))
        if bare not in best or rank < best[bare][0]:
            best[bare] = (rank, key, tag)

    models: dict[str, dict] = {}
    tag_counts: dict[str, int] = {tag: 0 for tag in NATIVE_PROVIDERS}
    for bare, (_, key, tag) in best.items():
        entry = dataset[key]
        models[bare] = {k: entry[k] for k in _KEPT_FIELDS if k in entry}
        tag_counts[tag] += 1

    thin = {tag: n for tag, n in tag_counts.items() if n < _MIN_MODELS_PER_TAG}
    if thin:
        raise SystemExit(
            f"ERROR: provider(s) yielded too few models: {thin}. LiteLLM likely "
            "renamed a `litellm_provider` tag — update NATIVE_PROVIDERS."
        )
    return {"models": dict(sorted(models.items())), "_counts": tag_counts}


def build_snapshot(dataset: dict, ref: str, source: str | None) -> dict:
    selected = select_models(dataset)
    models = selected["models"]
    return {
        "_meta": {
            "source": source or _LITELLM_URL_TEMPLATE.format(ref=ref),
            "upstream": "BerriAI/litellm model_prices_and_context_window.json",
            "license": "MIT",
            "copyright": "Copyright (c) 2023 Berri AI",
            "ref": ref,
            "generated_by": "packages/runtime/scripts/refresh_model_prices.py",
            "units": "LiteLLM-native per-token USD; the proxy converts to per-1M at load",
            "scope": "native Anthropic/OpenAI/Google token-priced models (the hosts the proxy captures)",
            "model_count": len(models),
            "counts_by_provider": selected["_counts"],
            "note": "Vendored slice of LiteLLM pricing. Regenerate with the refresh script; do not hand-edit prices.",
        },
        "models": models,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source",
        default=None,
        help="Local path or URL to a LiteLLM dataset JSON (default: GitHub raw at --ref).",
    )
    parser.add_argument(
        "--ref",
        default="main",
        help="BerriAI/litellm git ref to fetch from (branch/tag/commit). Default: main.",
    )
    parser.add_argument(
        "--out",
        default=_SNAPSHOT_PATH,
        help="Output snapshot path (default: the proxy's model_prices.json).",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Don't write; exit non-zero if the snapshot would change (for CI).",
    )
    args = parser.parse_args()

    dataset = load_litellm_dataset(args.source, args.ref)
    snapshot = build_snapshot(dataset, args.ref, args.source)
    rendered = json.dumps(snapshot, indent=2, sort_keys=True) + "\n"

    counts = snapshot["_meta"]["counts_by_provider"]
    print(
        f"Selected {snapshot['_meta']['model_count']} models "
        f"(anthropic={counts['anthropic']}, openai={counts['openai']}, "
        f"google={counts['google']}).",
        file=sys.stderr,
    )

    if args.check:
        existing = ""
        if os.path.isfile(args.out):
            with open(args.out, encoding="utf-8") as f:
                existing = f.read()
        # Compare only the `models` payload; _meta carries ref/source/counts that
        # may legitimately differ between a check run and the committed file.
        if _models_of(existing) != _models_of(rendered):
            print(
                "Snapshot is STALE — re-run refresh_model_prices.py to update "
                f"{os.path.relpath(args.out, _REPO_ROOT)}",
                file=sys.stderr,
            )
            return 1
        print("Snapshot is up to date.", file=sys.stderr)
        return 0

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        f.write(rendered)
    print(
        f"Wrote {snapshot['_meta']['model_count']} models to "
        f"{os.path.relpath(args.out, _REPO_ROOT)}",
        file=sys.stderr,
    )
    return 0


def _models_of(text: str) -> dict:
    """Parse the `models` block out of a rendered snapshot, tolerating empties."""
    if not text.strip():
        return {}
    try:
        return json.loads(text).get("models", {})
    except json.JSONDecodeError:
        return {}


if __name__ == "__main__":
    sys.exit(main())
