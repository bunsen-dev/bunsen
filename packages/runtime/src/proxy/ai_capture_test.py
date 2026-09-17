"""
Self-contained unit tests for ai_capture.py SSE parsing, usage extraction,
and per-call cost estimation.

Run with: python3 ai_capture_test.py

Stdlib-only — no pytest required. Wired into `pnpm --filter @bunsen-dev/runtime
test:proxy` via package.json so it gates `pnpm test`.
"""

from __future__ import annotations

import math
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from ai_capture import (  # type: ignore
    AICapture,
    PRICING,
    _match_model_pricing,
    _resolve_pricing,
    _cost_from_pricing,
    _load_pricing,
    _is_model_priced,
)


def _almost(a: float, b: float, tol: float = 1e-6) -> bool:
    return math.isclose(a, b, abs_tol=tol)


def _make_responses_sse(usage: dict, model: str = "gpt-5.5") -> str:
    """Build an OpenAI Responses-API SSE stream with the given usage block.

    Mirrors the shape Codex CLI receives from /v1/responses: a created event,
    a couple of output_text deltas, then a terminal completed event carrying
    the authoritative usage.
    """
    created = json._json_dumps({  # type: ignore[attr-defined]
        "type": "response.created",
        "response": {"id": "resp_test", "model": model},
    })
    delta1 = json._json_dumps({  # type: ignore[attr-defined]
        "type": "response.output_text.delta",
        "output_index": 0,
        "delta": "Hello, ",
    })
    delta2 = json._json_dumps({  # type: ignore[attr-defined]
        "type": "response.output_text.delta",
        "output_index": 0,
        "delta": "world!",
    })
    completed = json._json_dumps({  # type: ignore[attr-defined]
        "type": "response.completed",
        "response": {
            "id": "resp_test",
            "model": model,
            "output": [
                {
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": "Hello, world!"}],
                }
            ],
            "usage": usage,
        },
    })
    return (
        f"event: response.created\ndata: {created}\n\n"
        f"event: response.output_text.delta\ndata: {delta1}\n\n"
        f"event: response.output_text.delta\ndata: {delta2}\n\n"
        f"event: response.completed\ndata: {completed}\n"
    )


# json.dumps shim — we need a stable callable name for the helper above
# without importing json at module top a second time. Just bind it.
import json  # noqa: E402

json._json_dumps = json.dumps  # type: ignore[attr-defined]


# ---------------------------------------------------------------------------

_ANTHROPIC_SSE = (
    'event: message_start\n'
    'data: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-4-6","usage":{"input_tokens":100,"output_tokens":0}}}\n\n'
    'event: content_block_start\n'
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n'
    'event: content_block_delta\n'
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n'
    'event: content_block_stop\n'
    'data: {"type":"content_block_stop","index":0}\n\n'
    'event: message_delta\n'
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}\n'
)


def test_anthropic_messages_sse_dispatch() -> None:
    """Anthropic SSE routes to the Anthropic parser and yields full state."""
    cap = AICapture()
    parsed = cap._parse_sse_response("anthropic", _ANTHROPIC_SSE)
    assert parsed["model"] == "claude-sonnet-4-6", parsed
    assert parsed["usage"]["input_tokens"] == 100, parsed
    assert parsed["usage"]["output_tokens"] == 42, parsed
    assert parsed["content"] == [{"type": "text", "text": "Hi"}], parsed
    usage = cap._extract_usage("anthropic", parsed)
    assert usage["inputTokens"] == 100
    assert usage["outputTokens"] == 42


def test_openai_responses_sse_dispatch() -> None:
    cap = AICapture()
    sse = _make_responses_sse(
        usage={
            "input_tokens": 1234,
            "output_tokens": 56,
            "input_tokens_details": {"cached_tokens": 100},
            "total_tokens": 1290,
        },
        model="gpt-5.5",
    )
    parsed = cap._parse_sse_response("openai", sse)
    assert parsed["model"] == "gpt-5.5", parsed
    assert parsed["id"] == "resp_test", parsed
    assert parsed["usage"]["input_tokens"] == 1234, parsed
    assert parsed["usage"]["output_tokens"] == 56, parsed
    assert parsed["usage"]["input_tokens_details"]["cached_tokens"] == 100, parsed
    assert isinstance(parsed["output"], list) and len(parsed["output"]) == 1, parsed

    usage = cap._extract_usage("openai", parsed)
    # inputTokens is normalized to fresh-only: 1234 total − 100 cached = 1134.
    assert usage["inputTokens"] == 1134
    assert usage["outputTokens"] == 56
    assert usage["cacheReadInputTokens"] == 100


def test_dispatcher_isolates_provider_namespaces() -> None:
    """The rigor win: anthropic-shaped events fed into the openai parser
    (e.g. via a misclassified host) produce an empty body, NOT a partial
    parse. Same for openai events fed into the anthropic parser. This is
    what the previous merged-loop design couldn't promise."""
    cap = AICapture()
    openai_sse = _make_responses_sse(
        usage={"input_tokens": 1, "output_tokens": 1},
        model="gpt-5.5",
    )

    # Anthropic events should NOT be picked up by the openai parser.
    cross_a = cap._parse_sse_response("openai", _ANTHROPIC_SSE)
    assert cross_a == {}, cross_a

    # OpenAI events should NOT be picked up by the anthropic parser.
    cross_b = cap._parse_sse_response("anthropic", openai_sse)
    assert cross_b == {}, cross_b

    # Unknown providers route to an empty body, not a silent reuse of either parser.
    cross_c = cap._parse_sse_response("google", openai_sse)
    assert cross_c == {}, cross_c
    cross_d = cap._parse_sse_response("bogus-provider", _ANTHROPIC_SSE)
    assert cross_d == {}, cross_d


def test_openai_chat_completions_usage_shape_still_works() -> None:
    """Non-SSE (parsed JSON) path with the older prompt_tokens shape."""
    cap = AICapture()
    body = {
        "model": "gpt-4o",
        "usage": {
            "prompt_tokens": 200,
            "completion_tokens": 25,
            "prompt_tokens_details": {"cached_tokens": 50},
        },
        "choices": [{"message": {"role": "assistant", "content": "ok"}}],
    }
    usage = cap._extract_usage("openai", body)
    # Fresh-only: 200 prompt_tokens − 50 cached = 150.
    assert usage["inputTokens"] == 150
    assert usage["outputTokens"] == 25
    assert usage["cacheReadInputTokens"] == 50
    content = cap._extract_content("openai", body)
    assert content == {"role": "assistant", "content": "ok"}, content


def test_openai_responses_output_extracted_as_array() -> None:
    cap = AICapture()
    body = {
        "model": "gpt-5.5",
        "output": [
            {"type": "message", "content": [{"type": "output_text", "text": "hi"}]}
        ],
    }
    content = cap._extract_content("openai", body)
    assert content == body["output"], content


def test_openai_responses_truncated_stream_synthesizes_output() -> None:
    """If response.completed never arrived, accumulated text is still returned."""
    cap = AICapture()
    sse = (
        'event: response.created\n'
        'data: {"type":"response.created","response":{"id":"resp_x","model":"gpt-5.5"}}\n\n'
        'event: response.output_text.delta\n'
        'data: {"type":"response.output_text.delta","output_index":0,"delta":"part1 "}\n\n'
        'event: response.output_text.delta\n'
        'data: {"type":"response.output_text.delta","output_index":0,"delta":"part2"}\n'
    )
    parsed = cap._parse_sse_response("openai", sse)
    assert parsed["model"] == "gpt-5.5"
    assert parsed["output"][0]["content"][0]["text"] == "part1 part2", parsed


def test_iter_sse_events_skips_done_sentinel() -> None:
    """`data: [DONE]` is OpenAI Chat Completions' end-of-stream marker; it
    must not break parsing if it appears mixed in (e.g. captured proxy bytes
    from a misclassified flow)."""
    cap = AICapture()
    raw = (
        'data: {"type":"response.created","response":{"id":"r","model":"gpt-5.5"}}\n'
        'data: [DONE]\n'
    )
    events = list(cap._iter_sse_events(raw))
    assert len(events) == 1
    assert events[0]["type"] == "response.created"


def test_estimate_cost_gpt_5_5_pricing() -> None:
    """gpt-5.5: $5 / 1M input, $0.50 / 1M cached input, $30 / 1M output."""
    cap = AICapture()
    usage = {"inputTokens": 1234, "outputTokens": 56, "cacheReadInputTokens": 100}
    cost = cap._estimate_cost("openai", "gpt-5.5", usage)
    expected = (1234 / 1_000_000) * 5.0 + (56 / 1_000_000) * 30.0 + (100 / 1_000_000) * 0.5
    assert _almost(cost, round(expected, 6)), (cost, expected)


def test_estimate_cost_substring_matcher_picks_specific_first() -> None:
    """Most-specific match wins: gpt-5.5-pro prices at its own $30/$180, not at
    gpt-5.5's $5/$30, even though `gpt-5.5` is a substring of `gpt-5.5-pro`."""
    cap = AICapture()
    usage = {"inputTokens": 1_000_000, "outputTokens": 0}
    pro_cost = cap._estimate_cost("openai", "gpt-5.5-pro", usage)
    base_cost = cap._estimate_cost("openai", "gpt-5.5", usage)
    assert pro_cost == 30.0, pro_cost
    assert base_cost == 5.0, base_cost
    # gpt-5.4-mini resolves to its own $0.75 input via an exact match.
    mini_cost = cap._estimate_cost("openai", "gpt-5.4-mini", usage)
    assert mini_cost == 0.75, mini_cost


def test_estimate_cost_anthropic_sonnet_cache_pricing() -> None:
    """claude-sonnet-4-6 cache prices come from the vendored snapshot: cache
    write $3.75/1M, cache read $0.30/1M. (For sonnet these happen to equal the
    legacy 1.25x / 0.1x-of-input multipliers; see the haiku test for a model
    where the data and the multipliers diverge.)"""
    cap = AICapture()
    usage = {
        "inputTokens": 1_000_000,
        "outputTokens": 0,
        "cacheCreationInputTokens": 1_000_000,
        "cacheReadInputTokens": 1_000_000,
    }
    cost = cap._estimate_cost("anthropic", "claude-sonnet-4-6", usage)
    # input $3 + write $3.75 + read $0.30 (1M tokens in each bucket, per-1M rates).
    expected = 3.0 + 3.75 + 0.30
    assert _almost(cost, round(expected, 6)), (cost, expected)


def test_anthropic_cache_prices_are_data_driven() -> None:
    """claude-3-haiku-20240307 is the case where LiteLLM's explicit cache prices
    DIFFER from the legacy 1.25x / 0.1x multipliers, proving cache pricing is
    data-driven: data cache write $0.30/1M (the multiplier would give
    0.25*1.25 = $0.3125), data cache read $0.03/1M (multiplier 0.25*0.1 =
    $0.025)."""
    cap = AICapture()
    usage = {
        "inputTokens": 0,
        "outputTokens": 0,
        "cacheCreationInputTokens": 1_000_000,
        "cacheReadInputTokens": 1_000_000,
    }
    cost = cap._estimate_cost("anthropic", "claude-3-haiku-20240307", usage)
    expected = 0.30 + 0.03  # data-driven, NOT 0.3125 + 0.025
    assert _almost(cost, round(expected, 6)), (cost, expected)
    assert not _almost(cost, 0.3125 + 0.025), cost  # would mean multipliers leaked in


def test_opus_and_haiku4_pricing_is_data_driven() -> None:
    """Regressions for the stale hand-table the snapshot replaces:
    - claude-opus-4-7 now prices at its real $5/$25, not the $15/$75 the old
      table produced by substring-matching a generic `claude-opus-4` entry.
    - claude-haiku-4-5 now prices at $1/$5, not the $3/$15 default it fell
      through to (no `claude-3-haiku` substring matched it)."""
    cap = AICapture()
    usage = {"inputTokens": 1_000_000, "outputTokens": 1_000_000}
    assert _almost(cap._estimate_cost("anthropic", "claude-opus-4-7", usage), 5.0 + 25.0)
    assert _almost(cap._estimate_cost("anthropic", "claude-opus-4-6", usage), 5.0 + 25.0)
    assert _almost(cap._estimate_cost("anthropic", "claude-haiku-4-5", usage), 1.0 + 5.0)


def test_matcher_tolerates_date_suffixed_ids() -> None:
    """A response model id with a trailing date stamp still matches its base
    entry; the date is stripped (anchored at the end) before the fallback."""
    cap = AICapture()
    usage = {"inputTokens": 1_000_000, "outputTokens": 0}
    assert cap._estimate_cost("anthropic", "claude-sonnet-4-6-20260205", usage) == 3.0
    assert cap._estimate_cost("openai", "gpt-5.5-2026-04-23", usage) == 5.0
    assert cap._estimate_cost("anthropic", "claude-haiku-4-5@20251001", usage) == 1.0
    # A model whose canonical id legitimately ends in a date matches first via
    # the raw exact pass, so it is NOT mis-stripped to a wrong base.
    assert cap._estimate_cost("anthropic", "claude-3-haiku-20240307", usage) == 0.25


def test_matcher_strips_provider_routing_prefixes() -> None:
    """Provider-prefixed ids (gemini/, vertex_ai/, models/) match the bare key."""
    cap = AICapture()
    usage = {"inputTokens": 1_000_000, "outputTokens": 0}
    assert cap._estimate_cost("google", "gemini/gemini-2.5-pro", usage) == 1.25
    assert cap._estimate_cost("google", "vertex_ai/gemini-2.5-flash", usage) == 0.30
    assert cap._estimate_cost("google", "models/gemini-2.5-flash-lite", usage) == 0.10


def test_unknown_model_falls_back_to_coarse_default() -> None:
    """A model absent from the snapshot prices at the coarse per-provider
    default (safety net) rather than crashing or pricing at $0."""
    cap = AICapture()
    usage = {"inputTokens": 1_000_000, "outputTokens": 0}
    assert cap._estimate_cost("openai", "totally-made-up-model", usage) == 5.0
    assert cap._estimate_cost("some-unknown-provider", "whatever", usage) == 1.0


def test_unpriced_model_detection() -> None:
    """`_is_model_priced` distinguishes snapshot hits from coarse-default
    fallbacks — the signal behind a trace's `pricingFallback` flag and the
    `bn runs cost` warning."""
    assert _is_model_priced("openai", "gpt-5.5") is True
    assert _is_model_priced("openai", "gpt-4o") is True  # non-example, in snapshot
    assert _is_model_priced("anthropic", "claude-3-haiku-20240307") is True
    assert _is_model_priced("google", "gemini-2.5-pro") is True
    # Date-suffixed / provider-prefixed still count as priced (matcher normalizes).
    assert _is_model_priced("anthropic", "claude-sonnet-4-6-20260205") is True
    # Unrecognized / pruned / unknown-provider models are NOT priced.
    assert _is_model_priced("openai", "totally-made-up-model") is False
    assert _is_model_priced("anthropic", "claude-2.0") is False
    assert _is_model_priced("some-unknown-provider", "whatever") is False


def test_substring_only_match_is_flagged_not_confident() -> None:
    """A model absent from the snapshot but CONTAINING a shorter key as a
    substring (e.g. the real `o1-mini` ⊃ `o1`, or `gpt-4.5` ⊃ `gpt-4`) is priced
    via the substring as a best-effort guess but reported `matched=False`/
    flagged — so a near-miss can't masquerade as a confident, data-driven cost
    (`o1-mini` must not silently bill at `o1`'s rate)."""
    cap = AICapture()
    usage = {"inputTokens": 1_000_000, "outputTokens": 0}

    # A synthetic variant that can never become an exact snapshot key but
    # substring-matches `gpt-5.5`: priced (best-effort) yet flagged.
    base = "gpt-5.5"
    assert _is_model_priced("openai", base) is True  # exact key → confident
    variant = base + "-frobnicate-9"
    record, matched = _resolve_pricing("openai", variant)
    assert record is not None, variant      # still gets a best-effort price
    assert matched is False, variant         # but NOT confident → flagged
    assert _is_model_priced("openai", variant) is False
    assert cap._estimate_cost("openai", variant, usage) > 0  # still priced

    # The concrete real-world cases from review (guarded so a future refresh that
    # adds these as exact keys won't make the test lie).
    for absent in ("o1-mini", "o1-preview", "gpt-4.5"):
        if absent not in PRICING["openai"]:
            assert _is_model_priced("openai", absent) is False, absent


def test_warn_unpriced_model_dedupes() -> None:
    """The proxy warns once per unrecognized model (no per-call spam), and runs
    without mitmproxy present (falls back to stderr)."""
    cap = AICapture()
    devnull = open(os.devnull, "w")
    saved = sys.stderr
    sys.stderr = devnull  # silence the expected warnings
    try:
        cap._warn_unpriced_model("openai", "made-up-x")
        cap._warn_unpriced_model("openai", "made-up-x")  # same model -> deduped
        cap._warn_unpriced_model("openai", "made-up-y")
    finally:
        sys.stderr = saved
        devnull.close()
    assert cap._warned_unpriced_models == {"openai:made-up-x", "openai:made-up-y"}


class _StubLog:
    def info(self, *a, **k): pass
    def warn(self, *a, **k): pass
    def error(self, *a, **k): pass


class _StubCtx:
    log = _StubLog()


class _FakeHeaders:
    """Case-insensitive header map, mirroring mitmproxy's `http.Headers`.

    The addon reads/deletes `x-bunsen-source` in lowercase while real clients
    send `X-Bunsen-Source`; a plain dict would make the strip test pass for the
    wrong reason.
    """

    def __init__(self, initial=None):
        self._d = {}
        for k, v in (initial or {}).items():
            self[k] = v

    def __setitem__(self, key, value):
        self._d[key.lower()] = value

    def __getitem__(self, key):
        return self._d[key.lower()]

    def __delitem__(self, key):
        del self._d[key.lower()]

    def __contains__(self, key):
        return key.lower() in self._d

    def get(self, key, default=None):
        return self._d.get(key.lower(), default)

    def items(self):
        return self._d.items()


class _FakeReq:
    def __init__(self, host, path, content, headers=None):
        self.pretty_host = host
        self.path = path
        self.content = content
        self.headers = _FakeHeaders(headers)


class _FakeResp:
    def __init__(self, content, status=200):
        self.content = content
        self.status_code = status


class _FakeFlow:
    _n = 0

    def __init__(self, host, path, req_body, resp_body, headers=None):
        self.request = _FakeReq(host, path, req_body, headers)
        self.response = _FakeResp(resp_body)
        _FakeFlow._n += 1
        self.id = f"fake-flow-{_FakeFlow._n}"


def _capture_trace(host, path, req_body, resp_body, headers=None):
    """Drive the real `request()` → `response()` path once and return the flow
    plus the single trace record it wrote.

    Bodies may be dicts (JSON-encoded here) or raw str/bytes (for SSE).
    """
    import ai_capture as mod  # type: ignore
    import tempfile

    def _encode(body):
        if isinstance(body, (bytes, bytearray)):
            return bytes(body)
        if isinstance(body, str):
            return body.encode()
        return json.dumps(body).encode()

    cap = AICapture()
    out = tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False)
    out.close()
    cap.output_file = out.name

    flow = _FakeFlow(host, path, _encode(req_body), _encode(resp_body), headers)

    saved_ctx = mod.ctx
    mod.ctx = _StubCtx()  # request()/response() log via module ctx
    devnull = open(os.devnull, "w")
    saved_err = sys.stderr
    sys.stderr = devnull
    try:
        cap.request(flow)
        cap.response(flow)
    finally:
        mod.ctx = saved_ctx
        sys.stderr = saved_err
        devnull.close()

    with open(out.name) as f:
        traces = [json.loads(line) for line in f if line.strip()]
    os.unlink(out.name)
    assert len(traces) == 1, traces
    return flow, traces[0]


def test_response_flags_only_unpriced_calls_in_trace() -> None:
    """End-to-end through the real response() path: a priced model writes a
    trace WITHOUT `pricingFallback`; an unrecognized model writes one WITH it.
    This is what `bn runs cost` rolls up into its warning."""
    import ai_capture as mod  # type: ignore
    import tempfile

    cap = AICapture()
    out = tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False)
    out.close()
    cap.output_file = out.name

    saved_ctx, saved_avail = mod.ctx, mod._MITMPROXY_AVAILABLE
    mod.ctx = _StubCtx()  # response() logs via module ctx; stub it for the test
    devnull = open(os.devnull, "w")
    saved_err = sys.stderr
    sys.stderr = devnull
    try:
        for model in ("claude-sonnet-4-6", "claude-2.0"):  # priced, then pruned/unknown
            resp = json.dumps(
                {"model": model, "usage": {"input_tokens": 100, "output_tokens": 10}}
            ).encode()
            flow = _FakeFlow(
                "api.anthropic.com", "/v1/messages",
                json.dumps({"model": model}).encode(), resp,
            )
            cap.request(flow)
            cap.response(flow)
    finally:
        mod.ctx, mod._MITMPROXY_AVAILABLE = saved_ctx, saved_avail
        sys.stderr = saved_err
        devnull.close()

    with open(out.name) as f:
        traces = [json.loads(line) for line in f if line.strip()]
    os.unlink(out.name)

    assert len(traces) == 2, traces
    assert traces[0]["model"] == "claude-sonnet-4-6"
    assert "pricingFallback" not in traces[0]  # priced from snapshot
    assert traces[1]["model"] == "claude-2.0"
    assert traces[1]["pricingFallback"] is True  # coarse default -> flagged
    assert traces[1]["estimatedCostUsd"] > 0


def test_loader_degrades_gracefully_without_snapshot() -> None:
    """Offline-safety: if the snapshot file is missing/unreadable, the loader
    returns empty per-provider tables (so the proxy keeps capturing traces and
    every model hits the coarse default) instead of raising at import time."""
    devnull = open(os.devnull, "w")
    saved = sys.stderr
    sys.stderr = devnull  # silence the expected one-line warning
    try:
        table = _load_pricing("/definitely/not/a/real/path/model_prices.json")
    finally:
        sys.stderr = saved
        devnull.close()
    assert table == {"anthropic": {}, "openai": {}, "google": {}, "other": {}}


def _load_pricing_quiet(snapshot: dict) -> dict:
    """Write `snapshot` to a temp file, load it with stderr silenced, clean up."""
    import tempfile
    f = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
    json.dump(snapshot, f)
    f.close()
    devnull = open(os.devnull, "w")
    saved = sys.stderr
    sys.stderr = devnull
    try:
        return _load_pricing(f.name)
    finally:
        sys.stderr = saved
        devnull.close()
        os.unlink(f.name)


def test_loader_skips_malformed_entry_without_crashing() -> None:
    """A non-numeric price must not crash _load_pricing (which runs at import,
    so a crash would silence ALL capture) — the bad entry is skipped, good
    entries still load, and `_meta` is never ingested as a model."""
    table = _load_pricing_quiet({
        "_meta": {"note": "provenance"},
        "models": {
            "good-model": {"litellm_provider": "openai", "input_cost_per_token": 3e-06, "output_cost_per_token": 1e-05},
            "bad-model": {"litellm_provider": "openai", "input_cost_per_token": "not-a-number", "output_cost_per_token": 1e-05},
        },
    })
    assert "good-model" in table["openai"]
    assert "bad-model" not in table["openai"]  # malformed → skipped, not crashed
    assert "_meta" not in table["other"]       # sibling of `models`, never iterated


def test_loader_requires_models_wrapper() -> None:
    """A snapshot without a 'models' object fails closed to empty tables (coarse
    defaults) instead of ingesting top-level keys (e.g. `_meta`) as models."""
    table = _load_pricing_quiet({
        "_meta": {"x": 1},
        "claude-x": {"litellm_provider": "anthropic", "input_cost_per_token": 1e-06, "output_cost_per_token": 1e-06},
    })
    assert table == {"anthropic": {}, "openai": {}, "google": {}, "other": {}}


def test_openai_cached_input_billed_once_end_to_end() -> None:
    """Regression for the cached-token double-count bug. OpenAI reports a
    cache-INCLUSIVE input total with the cached portion as a subset; the
    extract→estimate pipeline must bill each cached token exactly once (at the
    cached rate), never also at the full input rate.

    Real numbers from the v1 codex hello-world run (gpt-5.5: $5/$0.5/$30):
    27,036 input (incl. cache) / 17,664 cached / 78 output.
    """
    cap = AICapture()
    body = {
        "model": "gpt-5.5",
        "usage": {
            "input_tokens": 27036,
            "output_tokens": 78,
            "input_tokens_details": {"cached_tokens": 17664},
        },
    }
    usage = cap._extract_usage("openai", body)
    assert usage["inputTokens"] == 27036 - 17664  # 9,372 fresh
    assert usage["cacheReadInputTokens"] == 17664

    cost = cap._estimate_cost("openai", "gpt-5.5", usage)
    # Each token billed in exactly one bucket: fresh@5, cached@0.5, output@30.
    expected = (9372 / 1e6) * 5.0 + (17664 / 1e6) * 0.5 + (78 / 1e6) * 30.0
    assert _almost(cost, round(expected, 6)), (cost, expected)
    assert _almost(cost, 0.058032), cost  # matches the task's corrected figure

    # The pre-fix bug billed the cached tokens twice (once inside the 27,036
    # total at $5, again at $0.5). Confirm we are strictly below that.
    buggy = (27036 / 1e6) * 5.0 + (17664 / 1e6) * 0.5 + (78 / 1e6) * 30.0
    assert cost < buggy
    # The overcharge was exactly the cached tokens at the full input rate.
    assert _almost(round(buggy, 6) - cost, round((17664 / 1e6) * 5.0, 6))


def test_gemini_cached_input_billed_once_end_to_end() -> None:
    """Same double-count regression for Gemini, whose `promptTokenCount` is
    cache-inclusive with `cachedContentTokenCount` as a subset."""
    cap = AICapture()
    body = {
        "modelVersion": "gemini-2.5-pro",
        "usageMetadata": {
            "promptTokenCount": 100_000,
            "candidatesTokenCount": 5_000,
            "cachedContentTokenCount": 60_000,
            "totalTokenCount": 105_000,
        },
    }
    usage = cap._extract_usage("google", body)
    assert usage["inputTokens"] == 40_000  # 100k total − 60k cached
    assert usage["cacheReadInputTokens"] == 60_000

    cost = cap._estimate_cost("google", "gemini-2.5-pro", usage)
    # gemini-2.5-pro (vendored snapshot): $1.25 input / $0.125 cached / $10 output.
    expected = (40_000 / 1e6) * 1.25 + (60_000 / 1e6) * 0.125 + (5_000 / 1e6) * 10.0
    assert _almost(cost, round(expected, 6)), (cost, expected)

    buggy = (100_000 / 1e6) * 1.25 + (60_000 / 1e6) * 0.125 + (5_000 / 1e6) * 10.0
    assert cost < buggy
    assert _almost(round(buggy, 6) - cost, round((60_000 / 1e6) * 1.25, 6))


def test_anthropic_cached_input_billed_once_end_to_end() -> None:
    """Anthropic was never affected (it reports cache reads/writes in disjoint
    fields), but the end-to-end path must keep billing each bucket once: fresh
    input @ input, cache write @ 1.25x, cache read @ 0.1x."""
    cap = AICapture()
    body = {
        "model": "claude-sonnet-4-6",
        "usage": {
            "input_tokens": 10_000,
            "output_tokens": 500,
            "cache_creation_input_tokens": 2_000,
            "cache_read_input_tokens": 40_000,
        },
    }
    usage = cap._extract_usage("anthropic", body)
    # input_tokens passes through unchanged — Anthropic's is already fresh-only.
    assert usage["inputTokens"] == 10_000
    assert usage["cacheCreationInputTokens"] == 2_000
    assert usage["cacheReadInputTokens"] == 40_000

    cost = cap._estimate_cost("anthropic", "claude-sonnet-4-6", usage)
    expected = (
        (10_000 / 1e6) * 3.0
        + (500 / 1e6) * 15.0
        + (2_000 / 1e6) * 3.0 * 1.25
        + (40_000 / 1e6) * 3.0 * 0.1
    )
    assert _almost(cost, round(expected, 6)), (cost, expected)


# The snapshot vendors EVERY native Anthropic/OpenAI/Google model LiteLLM tracks
# (see refresh_model_prices.py) — not just the models our example agents use —
# because a user's agent can reference any model the proxy might capture. These
# two lists are spot-checks, not the scope:
#   _EXAMPLE_AGENT_MODELS — models our example agents declare (regression net).
#   _COMMON_USER_MODELS    — common models NO example agent uses, proving the
#                            snapshot covers far more than the examples.
_EXAMPLE_AGENT_MODELS = {
    "anthropic": [
        "claude-sonnet-4-6",
        "claude-opus-4-6",
        "claude-opus-4-7",
        "claude-haiku-4-5",
        "claude-3-haiku-20240307",
    ],
    "openai": ["gpt-5.5", "gpt-5.4-mini", "gpt-5.3-codex"],
    "google": ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite"],
}
_COMMON_USER_MODELS = {
    "anthropic": ["claude-3-opus-20240229", "claude-3-7-sonnet-20250219"],
    "openai": ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "o1", "o3", "o3-mini"],
    "google": ["gemini-2.0-flash", "gemini-2.0-flash-lite"],
}

# Lower bounds on per-provider entry counts. Actual snapshot is ~21/150/47; these
# floors are well below that so normal upstream churn won't trip them, but a
# refresh that drops or empties a provider (e.g. LiteLLM renames a provider tag)
# fails loudly instead of silently shrinking coverage.
_MIN_ENTRIES = {"anthropic": 12, "openai": 60, "google": 25}


def _assert_resolves(cap, provider, model) -> None:
    assert model in PRICING[provider], (
        f"missing snapshot entry for {model}; have {len(PRICING[provider])} "
        f"{provider} models. Re-run refresh_model_prices.py."
    )
    # It must match EXACTLY (not just be present, and not a substring guess) and
    # price positively. `_match_model_pricing` returns (record, exact).
    record, exact = _match_model_pricing(PRICING[provider], model)
    assert record is not None and exact, model
    usage = {"inputTokens": 1_000_000, "outputTokens": 1_000_000}
    assert cap._estimate_cost(provider, model, usage) > 0, model


def test_example_agent_models_resolve() -> None:
    """Regression: every model our example agents declare resolves to a real
    snapshot entry (exact match), never the coarse per-provider default."""
    cap = AICapture()
    for provider, models in _EXAMPLE_AGENT_MODELS.items():
        for model in models:
            _assert_resolves(cap, provider, model)


def test_common_non_example_models_resolve_from_data() -> None:
    """Coverage breadth: common models that NO example agent uses (gpt-4o, o3,
    claude-3-opus, gemini-2.0-flash, …) still price from the snapshot, proving
    it covers the whole provider surface, not just our examples."""
    cap = AICapture()
    for provider, models in _COMMON_USER_MODELS.items():
        for model in models:
            _assert_resolves(cap, provider, model)


def test_snapshot_covers_each_provider_broadly() -> None:
    """A botched refresh that drops a provider must fail loudly, not silently
    shrink coverage to a handful of models."""
    for provider, floor in _MIN_ENTRIES.items():
        assert len(PRICING[provider]) >= floor, (
            f"{provider} has only {len(PRICING[provider])} entries (< {floor}); "
            "did refresh_model_prices.py drop a provider?"
        )


# ---------------------------------------------------------------------------
# Google Gemini coverage
# ---------------------------------------------------------------------------

def _make_gemini_sse(model: str = "gemini-2.5-pro") -> str:
    """Build a Gemini ?alt=sse stream. Each event is a bare `data: {...}`
    line whose payload is a full GenerateContentResponse chunk; usage
    accumulates across chunks and only the terminal chunk has the totals."""
    chunk1 = json.dumps({
        "candidates": [{
            "index": 0,
            "content": {"role": "model", "parts": [{"text": "Hello, "}]},
        }],
        "modelVersion": model,
        "responseId": "resp_gem_test",
    })
    chunk2 = json.dumps({
        "candidates": [{
            "index": 0,
            "content": {"role": "model", "parts": [{"text": "world!"}]},
            "finishReason": "STOP",
        }],
        "modelVersion": model,
        "responseId": "resp_gem_test",
        "usageMetadata": {
            "promptTokenCount": 25,
            "candidatesTokenCount": 7,
            "thoughtsTokenCount": 12,
            "totalTokenCount": 44,
        },
    })
    return f"data: {chunk1}\n\ndata: {chunk2}\n"


def test_google_sse_dispatch_extracts_usage_and_text() -> None:
    """Gemini's ?alt=sse stream routes to the Google parser via the
    bare-`data:` trigger added for non-Anthropic streams. Cumulative
    usage from the terminal chunk wins."""
    cap = AICapture()
    sse = _make_gemini_sse(model="gemini-2.5-pro")
    parsed = cap._parse_sse_response("google", sse)
    assert parsed["model"] == "gemini-2.5-pro", parsed
    assert parsed["id"] == "resp_gem_test", parsed
    assert parsed["usageMetadata"]["promptTokenCount"] == 25, parsed
    assert parsed["usageMetadata"]["candidatesTokenCount"] == 7, parsed
    assert parsed["usageMetadata"]["thoughtsTokenCount"] == 12, parsed
    # Text deltas merged across chunks per output index.
    assert parsed["candidates"][0]["content"]["parts"][0]["text"] == "Hello, world!", parsed

    usage = cap._extract_usage("google", parsed)
    assert usage["inputTokens"] == 25
    # outputTokens includes thoughts (billed at output rate for 2.5-pro).
    assert usage["outputTokens"] == 7 + 12


def test_google_sse_isolation_rejects_foreign_events() -> None:
    """Anthropic / OpenAI Responses events fed through the Google parser
    must produce an empty body, not a partial parse. This is the
    per-provider-namespace isolation contract."""
    cap = AICapture()
    openai_sse = _make_responses_sse(usage={"input_tokens": 1, "output_tokens": 1}, model="gpt-5.5")
    assert cap._parse_sse_response("google", openai_sse) == {}
    assert cap._parse_sse_response("google", _ANTHROPIC_SSE) == {}


def test_google_non_streaming_usage_extraction() -> None:
    """`generateContent` (non-streaming) returns a single GenerateContentResponse
    JSON. The proxy's JSON branch should extract usage + cached tokens."""
    cap = AICapture()
    body = {
        "candidates": [{
            "content": {"role": "model", "parts": [{"text": "ok"}]},
            "finishReason": "STOP",
        }],
        "modelVersion": "gemini-2.5-flash",
        "usageMetadata": {
            "promptTokenCount": 100,
            "candidatesTokenCount": 20,
            "cachedContentTokenCount": 60,
            "totalTokenCount": 120,
        },
    }
    usage = cap._extract_usage("google", body)
    # Fresh-only: 100 promptTokenCount − 60 cachedContentTokenCount = 40.
    assert usage["inputTokens"] == 40
    assert usage["outputTokens"] == 20
    assert usage["cacheReadInputTokens"] == 60
    # Model resolution falls back to modelVersion when the request body
    # didn't carry one (Gemini puts the model in the URL path).
    model = cap._extract_model("google", {}, body)
    assert model == "gemini-2.5-flash"
    content = cap._extract_content("google", body)
    assert content == body["candidates"][0]["content"], content


def test_estimate_cost_gemini_2_5_pro_pricing() -> None:
    """gemini-2.5-pro (from the vendored snapshot): $1.25 / 1M input,
    $0.125 / 1M cached read, $10 / 1M output."""
    cap = AICapture()
    usage = {"inputTokens": 1_000_000, "outputTokens": 100_000, "cacheReadInputTokens": 200_000}
    cost = cap._estimate_cost("google", "gemini-2.5-pro", usage)
    expected = 1.25 + (100_000 / 1_000_000) * 10.0 + (200_000 / 1_000_000) * 0.125
    assert _almost(cost, round(expected, 6)), (cost, expected)


def test_estimate_cost_gemini_substring_matcher_picks_specific_first() -> None:
    """gemini-2.5-flash-lite must price at its own $0.10 input, not at
    gemini-2.5-flash's $0.30 (of which `gemini-2.5-flash` is a substring)."""
    cap = AICapture()
    usage = {"inputTokens": 1_000_000, "outputTokens": 0}
    flash_lite = cap._estimate_cost("google", "gemini-2.5-flash-lite", usage)
    flash = cap._estimate_cost("google", "gemini-2.5-flash", usage)
    pro = cap._estimate_cost("google", "gemini-2.5-pro", usage)
    assert flash_lite == 0.10, flash_lite
    assert flash == 0.30, flash
    assert pro == 1.25, pro


# ---------------------------------------------------------------------------
# Non-streaming scorer traffic (the AI SDK's OpenAI + Google providers)
#
# The scorer bundle talks to OpenAI through `POST /v1/responses` with NO
# `stream` key at all, and to Gemini through `POST
# /v1beta/models/<model>:generateContent` (no `?alt=sse`). Both come back as a
# plain JSON body, so they take the JSON branch of `response()` — the path that
# had no end-to-end coverage before, even though every OpenAI/Gemini scorer's
# cost attribution depends on it.
# ---------------------------------------------------------------------------

def test_openai_responses_non_streaming_end_to_end() -> None:
    """A non-streaming Responses body prices and attributes correctly.

    Body shape is what @ai-sdk/openai receives for a tool-calling scorer turn:
    a `function_call` output item and a Responses-API usage block whose
    `input_tokens` is cache-INCLUSIVE.
    """
    request_body = {
        "model": "gpt-5.5",
        "input": [{"role": "user", "content": [{"type": "input_text", "text": "score it"}]}],
        "tools": [{"type": "function", "name": "submit_score"}],
    }
    response_body = {
        "id": "resp_nonstream_1",
        "object": "response",
        "model": "gpt-5.5-2026-04-23",
        "output": [
            {
                "type": "function_call",
                "name": "submit_score",
                "arguments": '{"summary":"Meets the criterion.","score":1}',
                "call_id": "call_abc123",
            }
        ],
        "usage": {
            "input_tokens": 1200,
            "input_tokens_details": {"cached_tokens": 200},
            "output_tokens": 40,
            "output_tokens_details": {"reasoning_tokens": 0},
            "total_tokens": 1240,
        },
    }
    _flow, trace = _capture_trace(
        "api.openai.com", "/v1/responses", request_body, response_body,
        headers={"X-Bunsen-Source": "scorer:code-quality"},
    )

    assert trace["provider"] == "openai", trace
    # `_extract_model` prefers the request body, which carries the alias the
    # scorer asked for; the response's date-stamped id is normalized by the
    # matcher anyway, so both price identically.
    assert trace["model"] == "gpt-5.5", trace
    assert trace["source"] == "scorer:code-quality", trace
    assert trace["endpoint"] == "/v1/responses", trace
    assert trace["statusCode"] == 200, trace

    usage = trace["response"]["usage"]
    assert usage["inputTokens"] == 1000, usage   # fresh = 1200 total − 200 cached
    assert usage["cacheReadInputTokens"] == 200, usage
    assert usage["outputTokens"] == 40, usage

    # The JSON branch must not fall through to the SSE parser or `_raw`.
    assert trace["response"]["content"] == response_body["output"], trace["response"]
    assert "_raw" not in trace["response"], trace["response"]

    record, exact = _resolve_pricing("openai", "gpt-5.5")
    assert exact, record
    expected = _cost_from_pricing(record, usage)
    assert expected > 0
    assert _almost(trace["estimatedCostUsd"], expected), (trace["estimatedCostUsd"], expected)
    assert "pricingFallback" not in trace, trace


def test_gemini_generate_content_non_streaming_end_to_end() -> None:
    """Non-streaming `generateContent` prices and attributes correctly.

    The model lives in the URL path, not the request body, so model resolution
    has to come from the response's `modelVersion`; thinking tokens bill at the
    output rate alongside `candidatesTokenCount`.
    """
    request_body = {
        "contents": [{"role": "user", "parts": [{"text": "write the report"}]}],
        "tools": [{"functionDeclarations": [{"name": "submit_report"}]}],
    }
    response_body = {
        "candidates": [
            {
                "content": {
                    "role": "model",
                    "parts": [
                        {
                            "functionCall": {
                                "name": "submit_report",
                                "args": {"report": "## Findings\n\nAll criteria met."},
                            }
                        }
                    ],
                },
                "finishReason": "STOP",
                "index": 0,
            }
        ],
        "modelVersion": "gemini-2.5-flash",
        "responseId": "resp_gem_nonstream",
        "usageMetadata": {
            "promptTokenCount": 900,
            "cachedContentTokenCount": 100,
            "candidatesTokenCount": 30,
            "thoughtsTokenCount": 50,
            "totalTokenCount": 980,
        },
    }
    _flow, trace = _capture_trace(
        "generativelanguage.googleapis.com",
        "/v1beta/models/gemini-2.5-flash:generateContent",
        request_body,
        response_body,
        headers={"X-Bunsen-Source": "scorer:summary-report"},
    )

    assert trace["provider"] == "google", trace
    assert trace["model"] == "gemini-2.5-flash", trace
    assert trace["source"] == "scorer:summary-report", trace
    assert trace["endpoint"] == "/v1beta/models/gemini-2.5-flash:generateContent", trace

    usage = trace["response"]["usage"]
    assert usage["inputTokens"] == 800, usage    # fresh = 900 − 100 cached
    assert usage["cacheReadInputTokens"] == 100, usage
    assert usage["outputTokens"] == 80, usage    # 30 candidates + 50 thoughts

    assert trace["response"]["content"] == response_body["candidates"][0]["content"], trace
    assert "_raw" not in trace["response"], trace["response"]

    record, exact = _resolve_pricing("google", "gemini-2.5-flash")
    assert exact, record
    expected = _cost_from_pricing(record, usage)
    assert expected > 0
    assert _almost(trace["estimatedCostUsd"], expected), (trace["estimatedCostUsd"], expected)
    assert "pricingFallback" not in trace, trace


def test_json_body_not_mistaken_for_sse() -> None:
    """The SSE-vs-JSON branch keys off the FIRST non-whitespace characters.

    A JSON body that merely *contains* `data:` inside a string (e.g. a scorer
    quoting a log line back) must still parse as JSON — routing it to the SSE
    parser would yield `{}` and silently zero its usage and cost. Conversely a
    body starting with `event:` must go to the SSE parser.
    """
    # JSON body carrying "data:" inside a text part, plus leading whitespace.
    json_body = {
        "candidates": [
            {
                "content": {
                    "role": "model",
                    "parts": [{"text": 'the log said: data: {"type":"x"} — ignore it'}],
                },
                "finishReason": "STOP",
            }
        ],
        "modelVersion": "gemini-2.5-flash",
        "usageMetadata": {"promptTokenCount": 50, "candidatesTokenCount": 5},
    }
    _flow, trace = _capture_trace(
        "generativelanguage.googleapis.com",
        "/v1beta/models/gemini-2.5-flash:generateContent",
        {"contents": []},
        "\n  " + json.dumps(json_body),
    )
    assert trace["response"]["usage"]["inputTokens"] == 50, trace
    assert trace["response"]["usage"]["outputTokens"] == 5, trace
    assert "_raw" not in trace["response"], trace["response"]
    assert trace["estimatedCostUsd"] > 0, trace

    # A body whose first non-whitespace chars are `event:` takes the SSE branch.
    _flow2, sse_trace = _capture_trace(
        "api.anthropic.com", "/v1/messages",
        {"model": "claude-sonnet-4-6"}, _ANTHROPIC_SSE,
    )
    assert sse_trace["response"]["usage"]["inputTokens"] == 100, sse_trace
    assert sse_trace["response"]["usage"]["outputTokens"] == 42, sse_trace
    assert "_raw" not in sse_trace["response"], sse_trace["response"]


def test_source_header_stripped_and_defaults_to_agent() -> None:
    """`X-Bunsen-Source` is a Bunsen-internal tag: it's recorded on the trace
    (so `usage.by_source` can attribute per-criterion scorer cost) and stripped
    before the request is forwarded upstream. A request without it is `agent`."""
    body = {"model": "claude-sonnet-4-6"}
    resp = {"model": "claude-sonnet-4-6", "usage": {"input_tokens": 10, "output_tokens": 1}}

    flow, trace = _capture_trace(
        "api.anthropic.com", "/v1/messages", body, resp,
        headers={"X-Bunsen-Source": "scorer:rubric", "Authorization": "Bearer k"},
    )
    assert trace["source"] == "scorer:rubric", trace
    assert "x-bunsen-source" not in flow.request.headers  # stripped before forwarding
    assert "X-Bunsen-Source" not in flow.request.headers  # ...case-insensitively
    assert flow.request.headers.get("Authorization") == "Bearer k"  # others untouched

    _flow2, default_trace = _capture_trace(
        "api.anthropic.com", "/v1/messages", body, resp,
    )
    assert default_trace["source"] == "agent", default_trace


# ---------------------------------------------------------------------------

def main() -> int:
    tests = [
        test_anthropic_messages_sse_dispatch,
        test_openai_responses_sse_dispatch,
        test_dispatcher_isolates_provider_namespaces,
        test_openai_chat_completions_usage_shape_still_works,
        test_openai_responses_output_extracted_as_array,
        test_openai_responses_truncated_stream_synthesizes_output,
        test_iter_sse_events_skips_done_sentinel,
        test_estimate_cost_gpt_5_5_pricing,
        test_estimate_cost_substring_matcher_picks_specific_first,
        test_estimate_cost_anthropic_sonnet_cache_pricing,
        test_anthropic_cache_prices_are_data_driven,
        test_opus_and_haiku4_pricing_is_data_driven,
        test_matcher_tolerates_date_suffixed_ids,
        test_matcher_strips_provider_routing_prefixes,
        test_unknown_model_falls_back_to_coarse_default,
        test_unpriced_model_detection,
        test_substring_only_match_is_flagged_not_confident,
        test_warn_unpriced_model_dedupes,
        test_response_flags_only_unpriced_calls_in_trace,
        test_loader_degrades_gracefully_without_snapshot,
        test_loader_skips_malformed_entry_without_crashing,
        test_loader_requires_models_wrapper,
        test_openai_cached_input_billed_once_end_to_end,
        test_gemini_cached_input_billed_once_end_to_end,
        test_anthropic_cached_input_billed_once_end_to_end,
        test_example_agent_models_resolve,
        test_common_non_example_models_resolve_from_data,
        test_snapshot_covers_each_provider_broadly,
        test_google_sse_dispatch_extracts_usage_and_text,
        test_google_sse_isolation_rejects_foreign_events,
        test_google_non_streaming_usage_extraction,
        test_estimate_cost_gemini_2_5_pro_pricing,
        test_estimate_cost_gemini_substring_matcher_picks_specific_first,
        test_openai_responses_non_streaming_end_to_end,
        test_gemini_generate_content_non_streaming_end_to_end,
        test_json_body_not_mistaken_for_sse,
        test_source_header_stripped_and_defaults_to_agent,
    ]
    failures = 0
    for t in tests:
        try:
            t()
            print(f"  ✓ {t.__name__}")
        except AssertionError as e:
            failures += 1
            print(f"  ✗ {t.__name__}: {e}")
        except Exception as e:
            failures += 1
            print(f"  ✗ {t.__name__}: {type(e).__name__}: {e}")
    if failures:
        print(f"\n{failures}/{len(tests)} tests failed")
        return 1
    print(f"\nall {len(tests)} ai_capture tests passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
