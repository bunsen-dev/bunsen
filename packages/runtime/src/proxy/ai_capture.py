# SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
"""
mitmproxy addon for capturing AI API calls.

This addon intercepts HTTP(S) requests to known AI providers
(Anthropic, OpenAI, Google) and logs them in a structured JSON format.

IMPORTANT: We only capture MODEL INFERENCE calls, not infrastructure calls.
AI provider APIs serve multiple purposes beyond model inference:
- Feature flags, settings, telemetry, health checks, etc.
These are filtered out to keep traces focused on actual AI reasoning.

Usage:
    mitmdump -s ai_capture.py --set output_file=/traces/agent.jsonl
"""

from __future__ import annotations

import json
import re
import time
import os
import sys
from datetime import datetime

# mitmproxy is only available inside the proxy sidecar container. The pure
# parsing/pricing helpers in this module are also imported by unit tests
# running in environments without it; degrade gracefully when it's absent so
# the helper layer stays testable.
try:
    from mitmproxy import http, ctx
    _MITMPROXY_AVAILABLE = True
except ImportError:
    http = None  # type: ignore
    ctx = None  # type: ignore
    _MITMPROXY_AVAILABLE = False


# =============================================================================
# ENDPOINT CONFIGURATION
# =============================================================================
#
# We only capture requests to these endpoint patterns. All other requests to
# AI provider hosts are ignored (e.g., telemetry, feature flags, settings).
#
# Each provider maps to a list of regex patterns for endpoints to capture.
# =============================================================================

# Anthropic: Only capture Messages API calls
# - /v1/messages: Chat completions (main inference endpoint)
# - /v1/messages/count_tokens: Token counting (useful for cost analysis)
# Ignored: /api/hello, /api/event_logging/*, /api/eval/*, /api/claude_code/*
ANTHROPIC_INFERENCE_ENDPOINTS = [
    r"^/v1/messages",           # Includes /v1/messages and /v1/messages/count_tokens
]

# OpenAI: Only capture completion endpoints
# - /v1/chat/completions: Chat completions
# - /v1/completions: Legacy completions
# - /v1/responses: Responses API (used by Codex CLI and Agents SDK)
# - /v1/embeddings: Embeddings (may be useful for RAG agents)
# Ignored: /v1/models, /v1/files, /v1/fine-tuning, etc.
OPENAI_INFERENCE_ENDPOINTS = [
    r"^/v1/chat/completions",
    r"^/v1/completions",
    r"^/v1/responses",
    r"^/v1/embeddings",
]

# Google: Only capture generation endpoints
# - generateContent: Main inference endpoint
# - streamGenerateContent: Streaming inference
# - countTokens: Token counting
GOOGLE_INFERENCE_ENDPOINTS = [
    r"generateContent",
    r"streamGenerateContent",
    r"countTokens",
]


# =============================================================================
# PROVIDER HOST MAPPING
# =============================================================================

AI_PROVIDERS = {
    "api.anthropic.com": "anthropic",
    "api.openai.com": "openai",
    "generativelanguage.googleapis.com": "google",
    "api.gemini.google.com": "google",
}

# Map providers to their inference endpoint patterns
INFERENCE_ENDPOINTS = {
    "anthropic": ANTHROPIC_INFERENCE_ENDPOINTS,
    "openai": OPENAI_INFERENCE_ENDPOINTS,
    "google": GOOGLE_INFERENCE_ENDPOINTS,
}

# =============================================================================
# MODEL PRICING (data-driven, vendored from LiteLLM)
# =============================================================================
#
# Prices come from a checked-in snapshot (`model_prices.json`) that is a
# filtered slice of LiteLLM's community pricing dataset (BerriAI/litellm, MIT),
# refreshed by `packages/runtime/scripts/refresh_model_prices.py`. The proxy
# never fetches at runtime, so a run's cost is reproducible from repo state.
#
# The snapshot stores LiteLLM's NATIVE per-token costs and field names; we
# convert per-token -> per-1M here at load so `_estimate_cost`'s math (which
# divides token counts by 1e6) stays unchanged. LiteLLM's explicit
# `cache_read_input_token_cost` / `cache_creation_input_token_cost` make the
# cached-read and cache-write prices data-driven instead of hard-coded
# 0.1x / 1.25x-of-input multipliers.

_SNAPSHOT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "model_prices.json")

# Coarse per-provider fallback, used ONLY when a captured model matches nothing
# in the snapshot. Every model our agent variants declare IS in the snapshot (a
# coverage test enforces it), so this is purely a safety net for genuinely
# unknown models — it keeps the proxy capturing traces instead of crashing or
# pricing at $0. This is not a maintained price table; the values are rough.
_DEFAULT_PRICING = {
    "anthropic": {"input": 3.0, "output": 15.0},
    "openai": {"input": 5.0, "cached_input": 0.5, "output": 30.0},
    "google": {"input": 0.30, "cached_input": 0.075, "output": 2.50},
    "other": {"input": 1.0, "output": 3.0},
}


def _provider_tag(litellm_provider: str) -> str:
    """Map a LiteLLM `litellm_provider` value to Bunsen's provider tag."""
    lp = (litellm_provider or "").lower()
    if "anthropic" in lp:
        return "anthropic"
    if "vertex" in lp or "gemini" in lp or "google" in lp:
        return "google"
    if "openai" in lp:
        return "openai"
    return "other"


def _per_million(per_token):
    """Convert a LiteLLM per-token USD cost to per-1M-token USD."""
    if per_token is None:
        return None
    # Round to absorb float noise (1e-7 * 1e6 -> 0.09999999999999999 -> 0.1).
    return round(per_token * 1_000_000, 8)


def _load_pricing(path: str = _SNAPSHOT_PATH) -> dict:
    """Load the vendored snapshot into the internal pricing table.

    Shape: {provider_tag: {model_id: {input, output, cached_input?,
    cache_creation?}}} with all prices in per-1M-token USD.

    Degrades to empty per-provider tables (so every model hits the coarse
    default) if the snapshot is missing, unreadable, mis-shaped, or carries a
    malformed entry — rather than taking the proxy down. A missing/bad snapshot
    must NEVER silence trace capture. In practice the snapshot ships beside this
    file and is mounted into the proxy container.
    """
    table = {"anthropic": {}, "openai": {}, "google": {}, "other": {}}
    try:
        with open(path, encoding="utf-8") as f:
            raw = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        # OSError covers a missing file and the IsADirectoryError that Docker's
        # auto-created empty mount dir produces when the host snapshot is absent.
        print(
            f"[ai_capture] WARNING: could not load pricing snapshot {path}: {e}; "
            "falling back to coarse default prices",
            file=sys.stderr,
        )
        return table

    # Require the `models` wrapper; never iterate the bare object (which would
    # ingest the `_meta` block as a phantom model). Fail closed to coarse defaults.
    models = raw.get("models")
    if not isinstance(models, dict):
        print(
            f"[ai_capture] WARNING: pricing snapshot {path} has no 'models' object; "
            "falling back to coarse default prices",
            file=sys.stderr,
        )
        return table

    for model_id, entry in models.items():
        if not isinstance(entry, dict):
            continue
        try:
            rec = {
                "input": _per_million(entry.get("input_cost_per_token")) or 0.0,
                "output": _per_million(entry.get("output_cost_per_token")) or 0.0,
            }
            cached = _per_million(entry.get("cache_read_input_token_cost"))
            if cached is not None:
                rec["cached_input"] = cached
            cache_write = _per_million(entry.get("cache_creation_input_token_cost"))
            if cache_write is not None:
                rec["cache_creation"] = cache_write
        except (TypeError, ValueError) as e:
            # A malformed entry (e.g. a non-numeric price) must not crash the
            # import — that would silence ALL capture. Skip it; the model then
            # hits the coarse default and is flagged like any unpriced one.
            print(
                f"[ai_capture] WARNING: skipping malformed pricing entry "
                f"{model_id!r}: {e}",
                file=sys.stderr,
            )
            continue
        tag = _provider_tag(entry.get("litellm_provider", ""))
        table.setdefault(tag, {})[model_id.lower()] = rec
    return table


PRICING = _load_pricing()


# Trailing date/version stamps some providers append to the model id in
# responses, e.g. `claude-sonnet-4-6-20260205`, `gpt-5.5-2026-04-23`,
# `claude-haiku-4-5@20251001`. Stripped (anchored at end) so a date-suffixed id
# falls back to its base entry. Models whose canonical id legitimately ends in a
# date (e.g. `claude-3-haiku-20240307`) still match first via the raw exact pass.
_DATE_SUFFIX_RE = re.compile(r"[-@]20\d{2}(?:-?\d{2}){2}$")


def _normalize_model_id(model: str) -> str:
    """Lowercase and strip a provider routing prefix from a captured model id.

    `gemini/gemini-2.5-pro`, `vertex_ai/gemini-2.5-flash`, `models/gemini-2.5-pro`
    -> the bare id after the last `/`. Dotted region prefixes
    (`us.anthropic.claude-...`) are left to the substring fallback, which still
    matches the embedded base id.
    """
    m = (model or "").strip().lower()
    if "/" in m:
        m = m.rsplit("/", 1)[-1]
    return m


def _match_model_pricing(provider_pricing: dict, model: str):
    """Resolve a captured model id to `(price_record, exact)`.

    `exact` is True for an exact key match on the raw, prefix-normalized, or
    date-suffix-stripped form. Otherwise the LONGEST snapshot key that is a
    substring of the most-normalized form is returned with `exact=False` — a
    best-effort guess, because a longer/variant id can CONTAIN a shorter real key
    without being the same model: `o1-mini` contains `o1`, `gpt-4.5` contains
    `gpt-4`. The caller surfaces a non-exact match as fallback-priced so a
    near-miss can't masquerade as an authoritative cost. Among exact-keyed
    siblings, longest-substring still preserves "most-specific wins"
    (`gpt-5.5-pro` beats `gpt-5.5`) without depending on dict insertion order.
    Returns `(None, False)` when nothing matches at all.
    """
    raw = (model or "").strip().lower()
    norm = _normalize_model_id(model)
    stripped = _DATE_SUFFIX_RE.sub("", norm)
    for cand in (raw, norm, stripped):
        if cand and cand in provider_pricing:
            return provider_pricing[cand], True
    # Substring fallback runs on the broadest (most-normalized) form; a hit here
    # is a guess (`exact=False`), not a confident, data-driven price.
    target = stripped or norm or raw
    best_key = None
    for key in provider_pricing:
        if key in target and (best_key is None or len(key) > len(best_key)):
            best_key = key
    if best_key is not None:
        return provider_pricing[best_key], False
    return None, False


def _resolve_pricing(provider: str, model: str):
    """Resolve `(price_record, matched)` for a captured call.

    `matched` is True ONLY for an exact snapshot match. A longest-substring guess
    or a total miss returns `matched=False` — i.e. the cost is a best-effort
    estimate, not a data-driven rate, so the caller stamps `pricingFallback`.
    Resolving cost and the flag from one match keeps the response path from
    matching the model twice.
    """
    provider_pricing = PRICING.get(provider, PRICING.get("other", {}))
    record, exact = _match_model_pricing(provider_pricing, model)
    if record is not None:
        return record, exact
    return _DEFAULT_PRICING.get(provider, _DEFAULT_PRICING["other"]), False


def _is_model_priced(provider: str, model: str) -> bool:
    """True if `model` resolves to an EXACT snapshot entry (a confident,
    data-driven price). A substring-only guess or a miss returns False so the
    cost is surfaced as a fallback estimate — e.g. `o1-mini` (absent, only
    substring-matching `o1`) is flagged rather than silently billed as `o1`."""
    return _resolve_pricing(provider, model)[1]


def _cost_from_pricing(model_pricing: dict, usage: dict) -> float:
    """Price the disjoint token buckets from a resolved price record.

    Relies on the `_extract_usage` CONVENTION that the three token buckets are
    DISJOINT for every provider: `inputTokens` is fresh (non-cached) input only,
    `cacheReadInputTokens` / `cacheCreationInputTokens` hold the cached portions
    separately. Because the buckets never overlap, each is priced independently
    and summed — no per-provider branching, and no token is billed twice. (If
    `inputTokens` were cache-inclusive, as the OpenAI/Gemini wire formats report
    it, cached tokens would be charged both at `input_price` and `cached_input`.)

    Cache-read and cache-write prices are data-driven from the snapshot (LiteLLM's
    `cache_read_input_token_cost` / `cache_creation_input_token_cost`), falling
    back to the historical 0.1x / 1.25x-of-input multipliers when absent.
    """
    input_price = model_pricing["input"]
    output_price = model_pricing["output"]
    cached_input_price = model_pricing.get("cached_input", input_price * 0.1)
    cache_write_price = model_pricing.get("cache_creation", input_price * 1.25)

    input_cost = (usage["inputTokens"] / 1_000_000) * input_price
    output_cost = (usage["outputTokens"] / 1_000_000) * output_price
    cache_write_cost = (usage.get("cacheCreationInputTokens", 0) / 1_000_000) * cache_write_price
    cache_read_cost = (usage.get("cacheReadInputTokens", 0) / 1_000_000) * cached_input_price

    return round(input_cost + output_cost + cache_write_cost + cache_read_cost, 6)


class AICapture:
    def __init__(self):
        self.output_file = None
        self.request_times = {}  # flow.id -> start_time
        self.request_sources = {}  # flow.id -> source tag ("agent" or "platform")
        self._warned_unpriced_models = set()  # "provider:model" already warned about

    def load(self, loader):
        loader.add_option(
            name="output_file",
            typespec=str,
            default="/traces/agent.jsonl",
            help="Output file for captured traces",
        )

    def configure(self, updates):
        if "output_file" in updates:
            self.output_file = ctx.options.output_file
            # Ensure output directory exists
            os.makedirs(os.path.dirname(self.output_file) or ".", exist_ok=True)
            ctx.log.info(f"AI capture writing to: {self.output_file}")

    def _is_inference_endpoint(self, provider: str, path: str) -> bool:
        """Check if the request path is a model inference endpoint.

        We only capture actual model inference calls, not infrastructure calls
        like telemetry, feature flags, settings, etc.
        """
        patterns = INFERENCE_ENDPOINTS.get(provider, [])
        for pattern in patterns:
            if re.search(pattern, path):
                return True
        return False

    def request(self, flow: http.HTTPFlow):
        """Record request start time and source tag for inference endpoints only."""
        host = flow.request.pretty_host
        if host not in AI_PROVIDERS:
            return

        provider = AI_PROVIDERS[host]
        path = flow.request.path

        if self._is_inference_endpoint(provider, path):
            self.request_times[flow.id] = time.time()

            # Read and strip the X-Bunsen-Source header (default: "agent")
            source = flow.request.headers.get("x-bunsen-source", "agent")
            self.request_sources[flow.id] = source
            # Strip the header before forwarding to the API
            if "x-bunsen-source" in flow.request.headers:
                del flow.request.headers["x-bunsen-source"]

            ctx.log.info(f"Capturing AI inference request to {host}{path} (source={source})")

    def response(self, flow: http.HTTPFlow):
        """Capture AI API responses for inference endpoints only."""
        host = flow.request.pretty_host

        if host not in AI_PROVIDERS:
            return

        provider = AI_PROVIDERS[host]
        path = flow.request.path

        # Only capture inference endpoints, skip infrastructure calls
        if not self._is_inference_endpoint(provider, path):
            # Clean up any lingering request time entry
            self.request_times.pop(flow.id, None)
            return

        start_time = self.request_times.pop(flow.id, time.time())
        latency_ms = int((time.time() - start_time) * 1000)
        source = self.request_sources.pop(flow.id, "agent")

        try:
            # Parse request body
            request_body = {}
            if flow.request.content:
                try:
                    request_body = json.loads(flow.request.content.decode("utf-8"))
                except (json.JSONDecodeError, UnicodeDecodeError):
                    request_body = {"_raw": flow.request.content.decode("utf-8", errors="replace")}

            # Parse response body — try SSE first, then JSON.
            # Anthropic SSE bodies start with `event:`. Gemini's `?alt=sse`
            # streams use bare `data: {...}` lines with no `event:` prefix,
            # and so does OpenAI Chat Completions streaming. Trigger SSE
            # parsing for both shapes; the per-provider parsers reject
            # foreign event vocabularies and return `{}` if the events
            # don't match the expected shape.
            response_body = {}
            if flow.response.content:
                raw_text = flow.response.content.decode("utf-8", errors="replace")
                stripped = raw_text.lstrip()
                if stripped.startswith("event:") or stripped.startswith("data:"):
                    response_body = self._parse_sse_response(provider, raw_text)
                else:
                    try:
                        response_body = json.loads(raw_text)
                    except (json.JSONDecodeError, UnicodeDecodeError):
                        response_body = {"_raw": raw_text}

            # Extract model name
            model = self._extract_model(provider, request_body, response_body)

            # Extract usage info
            usage = self._extract_usage(provider, response_body)

            # Calculate estimated cost. Resolve the price record once: `priced`
            # is False when no snapshot entry matched and the coarse default was
            # used, so the cost is a rough estimate, not a data-driven rate.
            model_pricing, priced = _resolve_pricing(provider, model)
            cost = _cost_from_pricing(model_pricing, usage)

            # Flag fallback-priced calls, gated on cost > 0 so $0 calls
            # (e.g. count_tokens) don't raise false alarms.
            pricing_fallback = cost > 0 and not priced
            if pricing_fallback:
                self._warn_unpriced_model(provider, model)

            # Extract content for easier viewing
            content = self._extract_content(provider, response_body)

            # Build trace record
            trace = {
                "provider": provider,
                "model": model,
                "endpoint": flow.request.path,
                "source": source,
                "timestamp": datetime.utcnow().isoformat() + "Z",
                "latencyMs": latency_ms,
                "request": {
                    "messages": request_body.get("messages"),
                    "system": request_body.get("system"),
                    **{k: v for k, v in request_body.items()
                       if k not in ("messages", "system")},
                },
                "response": {
                    "content": content,
                    "usage": usage,
                    **{k: v for k, v in response_body.items()
                       if k not in ("content", "usage", "choices")},
                },
                "estimatedCostUsd": cost,
                "statusCode": flow.response.status_code,
            }
            if pricing_fallback:
                trace["pricingFallback"] = True

            # Write trace to file
            self._write_trace(trace)
            ctx.log.info(f"Captured {provider} API call: {model}, {usage} (source={source})")

        except Exception as e:
            ctx.log.error(f"Error capturing AI trace: {e}")

    def _parse_sse_response(self, provider, raw_text):
        """Dispatch to a provider-specific SSE parser.

        Each provider's event vocabulary is parsed by its own function so the
        parsers stay isolated: an unexpected event from a different provider's
        namespace ends up as a no-op (and is observable via missing usage),
        rather than being silently consumed by an overlapping branch.

        OpenAI Chat Completions and Gemini's `?alt=sse` streams both use
        bare `data: {...}` lines with no `event:` prefix. The dispatcher
        is invoked for either shape; per-provider parsers reject foreign
        event vocabularies and return `{}` rather than partially parsing.
        Note: OpenAI Chat Completions streamed bodies still fall through
        as effectively-empty parses unless `stream_options.include_usage`
        was sent — a known gap, separate from this parser.
        """
        events = list(self._iter_sse_events(raw_text))
        if provider == "anthropic":
            return self._parse_anthropic_sse(events)
        if provider == "openai":
            return self._parse_openai_responses_sse(events)
        if provider == "google":
            return self._parse_google_sse(events)
        return {}

    def _iter_sse_events(self, raw_text):
        """Yield each parsed `data: {...}` JSON object from an SSE stream.

        Lines without a `data:` prefix and `data:` lines whose payload doesn't
        parse as JSON are skipped. Sentinel `data: [DONE]` is filtered too.
        """
        for line in raw_text.split("\n"):
            line = line.strip()
            if not line.startswith("data:"):
                continue
            data_str = line[len("data:"):].strip()
            if not data_str or data_str == "[DONE]":
                continue
            try:
                yield json.loads(data_str)
            except json.JSONDecodeError:
                continue

    def _parse_anthropic_sse(self, events):
        """Parse Anthropic Messages API SSE events.

        Recognized events:
        - message_start: carries model + initial input usage
        - content_block_start / content_block_delta / content_block_stop:
          accumulates text/tool_use/thinking blocks
        - message_delta: carries final output_tokens

        Any event whose `type` doesn't match this list is ignored — including
        events from another provider's namespace, which would have been
        silently consumed by the prior merged-loop design.
        """
        result = {}
        content_blocks = []
        current_block = None

        for data in events:
            event_type = data.get("type", "")

            if event_type == "message_start":
                msg = data.get("message", {})
                result["model"] = msg.get("model", "")
                result["id"] = msg.get("id", "")
                result["usage"] = msg.get("usage", {})

            elif event_type == "content_block_start":
                current_block = data.get("content_block", {})

            elif event_type == "content_block_delta":
                delta = data.get("delta", {})
                if current_block and delta.get("type") == "text_delta":
                    current_block["text"] = current_block.get("text", "") + delta.get("text", "")

            elif event_type == "content_block_stop":
                if current_block:
                    content_blocks.append(current_block)
                    current_block = None

            elif event_type == "message_delta":
                delta_usage = data.get("usage", {})
                if "output_tokens" in delta_usage:
                    result.setdefault("usage", {})["output_tokens"] = delta_usage["output_tokens"]

        if content_blocks:
            result["content"] = content_blocks
        return result

    def _parse_openai_responses_sse(self, events):
        """Parse OpenAI Responses API SSE events (used by Codex CLI).

        Recognized events:
        - response.created: initial response object (model + id)
        - response.output_text.delta: text token deltas, accumulated by
          `output_index` so multiple message items stay separate
        - response.completed: terminal event whose `response` object holds
          the authoritative usage and the full output array

        If the stream is truncated before `response.completed`, the
        accumulated text deltas are reconstructed into a minimal output
        array so cost/content extraction still has something usable.
        """
        result = {}
        output_text_by_index = {}

        for data in events:
            event_type = data.get("type", "")

            if event_type == "response.created":
                resp = data.get("response", {})
                if resp.get("model"):
                    result["model"] = resp["model"]
                if resp.get("id"):
                    result["id"] = resp["id"]

            elif event_type == "response.output_text.delta":
                idx = data.get("output_index", 0)
                output_text_by_index[idx] = (
                    output_text_by_index.get(idx, "") + (data.get("delta") or "")
                )

            elif event_type == "response.completed":
                resp = data.get("response", {})
                if resp.get("model"):
                    result["model"] = resp["model"]
                if resp.get("id"):
                    result["id"] = resp["id"]
                if resp.get("usage"):
                    result["usage"] = resp["usage"]
                if resp.get("output"):
                    result["output"] = resp["output"]

        if output_text_by_index and "output" not in result:
            result["output"] = [
                {
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": text}],
                }
                for _, text in sorted(output_text_by_index.items())
            ]
        return result

    def _parse_google_sse(self, events):
        """Parse Google Gemini `?alt=sse` streaming events.

        Each event is a `data: {...}` line whose payload is a full
        GenerateContentResponse chunk (no `event:` prefix, no per-event
        type discriminator). We accumulate text deltas across chunks and
        keep the latest non-empty `usageMetadata` and `modelVersion`,
        because Gemini emits cumulative usage on each chunk and only the
        terminal chunk has the authoritative totals.

        Foreign event shapes (e.g. an OpenAI `response.created` payload
        passed in via a misclassified flow) have no `candidates` /
        `usageMetadata` keys and end up contributing nothing — the parser
        returns an empty body, which is the desired behavior per the
        per-provider isolation contract.
        """
        result = {}
        accumulated_text_by_index = {}
        last_finish_reason = None

        for data in events:
            if not isinstance(data, dict):
                continue

            if "modelVersion" in data and not result.get("model"):
                result["model"] = data["modelVersion"]
            if "responseId" in data and not result.get("id"):
                result["id"] = data["responseId"]

            usage = data.get("usageMetadata")
            if isinstance(usage, dict) and usage:
                # Each chunk carries cumulative usage; last one wins.
                result["usageMetadata"] = usage

            for cand in data.get("candidates") or []:
                if not isinstance(cand, dict):
                    continue
                idx = cand.get("index", 0)
                if cand.get("finishReason"):
                    last_finish_reason = cand["finishReason"]
                content = cand.get("content") or {}
                for part in content.get("parts") or []:
                    if not isinstance(part, dict):
                        continue
                    text = part.get("text")
                    if isinstance(text, str) and text:
                        accumulated_text_by_index[idx] = (
                            accumulated_text_by_index.get(idx, "") + text
                        )

        # If we never saw any candidates / usageMetadata / modelVersion,
        # this stream wasn't a Gemini response — return empty so the
        # provider isolation contract holds.
        if not result and not accumulated_text_by_index:
            return {}

        if accumulated_text_by_index:
            result["candidates"] = [
                {
                    "index": idx,
                    "content": {
                        "role": "model",
                        "parts": [{"text": text}],
                    },
                    **({"finishReason": last_finish_reason} if last_finish_reason else {}),
                }
                for idx, text in sorted(accumulated_text_by_index.items())
            ]
        return result

    def _extract_model(self, provider, request_body, response_body):
        """Extract model name from request or response."""
        # Try request first
        model = request_body.get("model", "")

        # For Anthropic, also check response
        if provider == "anthropic" and not model:
            model = response_body.get("model", "")

        # For OpenAI, check response
        if provider == "openai" and not model:
            model = response_body.get("model", "")

        # For Google, the response field is `modelVersion`. The request
        # body's `model` is encoded in the URL path, not the JSON body —
        # but the request_body dict is built from the body bytes, so it
        # may be empty. Fall back to the response's modelVersion.
        if provider == "google" and not model:
            model = response_body.get("modelVersion", "") or response_body.get("model", "")

        return model or "unknown"

    def _extract_usage(self, provider, response_body):
        """Extract token usage from a response into Bunsen's normalized shape.

        CONVENTION — `inputTokens` is the count of *fresh* (non-cached) input
        tokens, disjoint from `cacheReadInputTokens` and
        `cacheCreationInputTokens`, for EVERY provider. The three buckets never
        overlap, so a token is counted in exactly one of them and `_estimate_cost`
        can price each bucket independently without per-provider special-casing.

        Providers disagree on what their wire format calls "input tokens":
          - Anthropic already reports `input_tokens` as fresh-only — cache reads
            and writes live in disjoint fields — so it maps straight through.
          - OpenAI (`input_tokens`/`prompt_tokens`) and Gemini
            (`promptTokenCount`) report a cache-INCLUSIVE total, with the cached
            portion as a *subset* (`cached_tokens` / `cachedContentTokenCount`).
            We subtract that subset here so `inputTokens` is fresh-only like
            Anthropic's. Without this, cached tokens would be billed twice —
            once at the full input price (inside the total) and again at the
            cached rate (see the historical 1.9x-4.5x cost inflation bug).
        """
        usage = {"inputTokens": 0, "outputTokens": 0}

        if provider == "anthropic":
            if "usage" in response_body:
                usage["inputTokens"] = response_body["usage"].get("input_tokens", 0)
                usage["outputTokens"] = response_body["usage"].get("output_tokens", 0)
                # Anthropic reports cache reads/writes in disjoint fields, so
                # input_tokens is already fresh-only — no subtraction needed.
                cache_creation = response_body["usage"].get("cache_creation_input_tokens", 0)
                cache_read = response_body["usage"].get("cache_read_input_tokens", 0)
                if cache_creation:
                    usage["cacheCreationInputTokens"] = cache_creation
                if cache_read:
                    usage["cacheReadInputTokens"] = cache_read

        elif provider == "openai":
            if "usage" in response_body:
                u = response_body["usage"]
                # OpenAI publishes two slightly different usage shapes:
                #   - Chat Completions / legacy Completions: prompt_tokens /
                #     completion_tokens, with prompt_tokens_details.cached_tokens
                #   - Responses API (used by Codex CLI): input_tokens /
                #     output_tokens, with input_tokens_details.cached_tokens
                # Read whichever is present.
                total_input = u.get("input_tokens", u.get("prompt_tokens", 0))
                usage["outputTokens"] = u.get("output_tokens", u.get("completion_tokens", 0))
                cached = (
                    (u.get("input_tokens_details") or {}).get("cached_tokens")
                    or (u.get("prompt_tokens_details") or {}).get("cached_tokens")
                    or 0
                )
                # `total_input` is cache-inclusive; `cached` is a subset of it.
                # Store fresh-only input so the buckets stay disjoint.
                usage["inputTokens"] = max(0, total_input - cached)
                if cached:
                    usage["cacheReadInputTokens"] = cached

        elif provider == "google":
            if "usageMetadata" in response_body:
                u = response_body["usageMetadata"]
                total_input = u.get("promptTokenCount", 0)
                # Gemini 2.5 reports thinking tokens separately from the
                # text-output tokens. Both are billed at the output rate,
                # so include both in outputTokens.
                output = u.get("candidatesTokenCount", 0) + u.get("thoughtsTokenCount", 0)
                usage["outputTokens"] = output
                cached = u.get("cachedContentTokenCount", 0)
                # `promptTokenCount` is cache-inclusive; `cachedContentTokenCount`
                # is a subset of it. Store fresh-only input (disjoint buckets).
                usage["inputTokens"] = max(0, total_input - cached)
                if cached:
                    usage["cacheReadInputTokens"] = cached

        return usage

    def _extract_content(self, provider, response_body):
        """Extract raw content from response (preserves full structure including tool calls)."""
        if provider == "anthropic":
            # Return raw content array (includes text, tool_use, thinking blocks)
            return response_body.get("content", [])

        elif provider == "openai":
            # Responses API: content lives in `output` (array of items, each
            # with its own `content` array). Returned as-is so consumers can
            # render text, function_call, reasoning, etc.
            output = response_body.get("output")
            if output:
                return output
            # Chat Completions: full message object including content + tool_calls.
            choices = response_body.get("choices", [])
            if choices and isinstance(choices, list):
                return choices[0].get("message", {})
            return {}

        elif provider == "google":
            # Return raw content object from first candidate
            candidates = response_body.get("candidates", [])
            if candidates and isinstance(candidates, list):
                return candidates[0].get("content", {})
            return {}

        return response_body.get("content", "")

    def _estimate_cost(self, provider, model, usage):
        """Estimate the USD cost of a captured call: resolve the model's price
        record (exact → longest-substring, coarse default on miss) then price the
        disjoint token buckets. See `_resolve_pricing` / `_cost_from_pricing`."""
        model_pricing, _matched = _resolve_pricing(provider, model)
        return _cost_from_pricing(model_pricing, usage)

    def _warn_unpriced_model(self, provider, model):
        """Warn once per unrecognized model (deduped, no per-call spam).

        The proxy's own log isn't surfaced to the user — the trace's
        `pricingFallback` flag, rolled up by `bn runs cost`, is the user-facing
        signal — but this still aids debugging via `docker logs` and flags a
        snapshot that needs refreshing.
        """
        key = f"{provider}:{model}"
        if key in self._warned_unpriced_models:
            return
        self._warned_unpriced_models.add(key)
        msg = (
            f"No pricing-snapshot entry for model '{model}' ({provider}); priced "
            "with a coarse default — cost is a rough estimate. Refresh "
            "model_prices.json if this model is current."
        )
        if _MITMPROXY_AVAILABLE and ctx is not None:
            ctx.log.warn(msg)
        else:
            print(f"[ai_capture] WARNING: {msg}", file=sys.stderr)

    def _write_trace(self, trace):
        """Append trace to output file."""
        if not self.output_file:
            return

        with open(self.output_file, "a") as f:
            f.write(json.dumps(trace) + "\n")


addons = [AICapture()]
