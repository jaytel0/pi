#!/usr/bin/env python3
"""Measure Smart Fast Mode on real Claude Opus 4.6 requests through Pi.

This script toggles ~/.pi/agent/fast-mode.json off/on, launches real `pi -p`
requests against Claude Opus 4.6, and records:

- whether Smart Fast Mode actually injected `speed: "fast"`
- whether the Claude Agent/Code identity block was present
- request status
- end-to-end wall-clock latency
- token usage from Pi's saved session file
- expected standard-vs-fast USD cost using the actual token counts

It installs a temporary late-sorting probe extension at
~/.pi/agent/extensions/zzzz-fast-benchmark-probe.ts so the probe runs after
zzz-fast-mode and observes the final provider payload.
"""

from __future__ import annotations

import json
import os
import pathlib
import statistics
import subprocess
import tempfile
import time
from typing import Any

ROOT = pathlib.Path(__file__).resolve().parents[1]
PROBE_SOURCE = ROOT / "tests" / "payload-probe.ts"
AGENT_DIR = pathlib.Path(os.environ.get("PI_CODING_AGENT_DIR", os.path.expanduser("~/.pi/agent")))
STATE_PATH = AGENT_DIR / "fast-mode.json"
PROBE_DEST = AGENT_DIR / "extensions" / "zzzz-fast-benchmark-probe.ts"

MODEL = os.environ.get("PI_FAST_BENCH_MODEL", "anthropic-250k-prefer-using-this-one/claude-opus-4-6")

PROMPTS = [
    "Write exactly 5 numbered bullet points about why cache locality matters in compilers. No intro.",
    "Write a 120-word explanation of event loops for a junior JavaScript developer. No code.",
    "Summarize the tradeoff between latency and throughput in distributed systems in 6 concise sentences.",
]

# Rates per million tokens. Standard matches the installed Shopify/Pi Opus 4.6
# provider config (5/25). Fast mode is Claude Code fast-mode pricing (30/150),
# documented by Anthropic, so the multiplier is 6x on both input/cache and output.
STANDARD_INPUT_PER_MTOK = 5.0
STANDARD_OUTPUT_PER_MTOK = 25.0
FAST_INPUT_PER_MTOK = 30.0
FAST_OUTPUT_PER_MTOK = 150.0


def read_state() -> str | None:
    return STATE_PATH.read_text() if STATE_PATH.exists() else None


def write_state(enabled: bool) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    STATE_PATH.write_text(json.dumps({"enabled": enabled}, indent="\t") + "\n")


def parse_session_usage(session_dir: pathlib.Path) -> dict[str, Any] | None:
    records: list[dict[str, Any]] = []
    for path in session_dir.rglob("*.jsonl"):
        for line in path.read_text(errors="ignore").splitlines():
            try:
                obj = json.loads(line)
            except Exception:
                continue
            msg = obj.get("message") if obj.get("type") == "message" else None
            if isinstance(msg, dict) and msg.get("role") == "assistant" and msg.get("model") == "claude-opus-4-6":
                usage = msg.get("usage") or {}
                records.append(
                    {
                        "input": usage.get("input", 0),
                        "output": usage.get("output", 0),
                        "cacheRead": usage.get("cacheRead", 0),
                        "cacheWrite": usage.get("cacheWrite", 0),
                        "totalTokens": usage.get("totalTokens", 0),
                        "piReportedCost": ((usage.get("cost") or {}).get("total")),
                        "stopReason": msg.get("stopReason"),
                        "responseId": msg.get("responseId"),
                    }
                )
    return records[-1] if records else None


def parse_probe(log_path: pathlib.Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    if not log_path.exists():
        return rows
    for line in log_path.read_text(errors="ignore").splitlines():
        try:
            rows.append(json.loads(line))
        except Exception:
            pass
    return rows


def computed_cost(usage: dict[str, Any], fast: bool) -> float:
    input_like = (usage.get("input", 0) + usage.get("cacheRead", 0) + usage.get("cacheWrite", 0)) / 1_000_000
    output = usage.get("output", 0) / 1_000_000
    if fast:
        return input_like * FAST_INPUT_PER_MTOK + output * FAST_OUTPUT_PER_MTOK
    return input_like * STANDARD_INPUT_PER_MTOK + output * STANDARD_OUTPUT_PER_MTOK


def install_probe() -> None:
    PROBE_DEST.parent.mkdir(parents=True, exist_ok=True)
    PROBE_DEST.write_text(PROBE_SOURCE.read_text())


def remove_probe() -> None:
    try:
        PROBE_DEST.unlink()
    except FileNotFoundError:
        pass


def run_one(prompt: str, enabled: bool, label: str) -> dict[str, Any]:
    write_state(enabled)
    tmp = pathlib.Path(tempfile.mkdtemp(prefix=f"pi-fast-{label}-"))
    probe_log = tmp / "probe.jsonl"
    session_dir = tmp / "sessions"

    env = os.environ.copy()
    env["PI_FAST_PROBE_LOG"] = str(probe_log)
    env.setdefault("PI_OFFLINE", "1")

    cmd = [
        "pi",
        "--no-tools",
        "--no-skills",
        "--no-prompt-templates",
        "--no-context-files",
        "--session-dir",
        str(session_dir),
        "--model",
        MODEL,
        "--thinking",
        "high",
        "-p",
        prompt,
    ]

    install_probe()
    start = time.perf_counter()
    try:
        proc = subprocess.run(cmd, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, timeout=180)
    finally:
        remove_probe()
    elapsed = time.perf_counter() - start

    probes = parse_probe(probe_log)
    before = next((row for row in probes if row.get("event") == "before_provider_request"), {})
    after = next((row for row in probes if row.get("event") == "after_provider_response"), {})
    usage = parse_session_usage(session_dir) or {}

    return {
        "label": label,
        "enabled": enabled,
        "exit": proc.returncode,
        "elapsed_s": elapsed,
        "stdout": proc.stdout.strip(),
        "stderr_tail": "\n".join(proc.stderr.splitlines()[-8:]),
        "payload_speed": before.get("speed"),
        "payload_thinking": before.get("thinking"),
        "has_agent_identity": before.get("hasClaudeAgentIdentity"),
        "provider": before.get("provider"),
        "model": before.get("model"),
        "status": after.get("status"),
        "usage": usage,
        "computed_standard_usd": computed_cost(usage, False) if usage else None,
        "computed_fast_usd": computed_cost(usage, True) if usage else None,
        "tmp": str(tmp),
    }


def short_result(result: dict[str, Any]) -> dict[str, Any]:
    usage = result["usage"]
    return {
        "run": result["label"],
        "elapsed_s": round(result["elapsed_s"], 3),
        "payload_speed": result["payload_speed"],
        "thinking": result["payload_thinking"],
        "agent_identity": result["has_agent_identity"],
        "status": result["status"],
        "input": usage.get("input"),
        "output": usage.get("output"),
        "cacheRead": usage.get("cacheRead"),
        "cacheWrite": usage.get("cacheWrite"),
        "computed_standard_usd": round(result["computed_standard_usd"], 6),
        "computed_fast_usd": round(result["computed_fast_usd"], 6),
    }


def main() -> None:
    old_state = read_state()
    results: list[dict[str, Any]] = []
    try:
        for enabled, label in [(False, "warm-standard"), (True, "warm-fast")]:
            warmup = run_one("Reply with exactly OK.", enabled, label)
            print(json.dumps({"warmup": label, "elapsed_s": round(warmup["elapsed_s"], 3), "speed": warmup["payload_speed"], "status": warmup["status"]}))

        for index, prompt in enumerate(PROMPTS, 1):
            # Alternate order to reduce temporal/network bias.
            order = [(False, "standard"), (True, "fast")] if index % 2 else [(True, "fast"), (False, "standard")]
            for enabled, label in order:
                result = run_one(prompt, enabled, f"{label}-{index}")
                if result["exit"] != 0:
                    raise RuntimeError(f"{result['label']} failed: {result['stderr_tail']}")
                results.append(result)
                print(json.dumps(short_result(result)))

        standards = [result for result in results if not result["enabled"]]
        fasts = [result for result in results if result["enabled"]]
        summary = {
            "model": MODEL,
            "standard_elapsed_s": [round(result["elapsed_s"], 3) for result in standards],
            "fast_elapsed_s": [round(result["elapsed_s"], 3) for result in fasts],
            "standard_mean_s": round(statistics.mean(result["elapsed_s"] for result in standards), 3),
            "fast_mean_s": round(statistics.mean(result["elapsed_s"] for result in fasts), 3),
            "speedup_mean": round(
                statistics.mean(result["elapsed_s"] for result in standards)
                / statistics.mean(result["elapsed_s"] for result in fasts),
                2,
            ),
            "all_standard_payload_speeds": [result["payload_speed"] for result in standards],
            "all_fast_payload_speeds": [result["payload_speed"] for result in fasts],
            "all_fast_had_agent_identity": all(result["has_agent_identity"] for result in fasts),
            "standard_total_computed_usd": round(sum(result["computed_standard_usd"] for result in standards), 6),
            "same_usage_at_fast_rates_usd": round(sum(result["computed_fast_usd"] for result in standards), 6),
            "fast_total_computed_usd": round(sum(result["computed_fast_usd"] for result in fasts), 6),
            "same_usage_at_standard_rates_usd": round(sum(result["computed_standard_usd"] for result in fasts), 6),
            "fast_rate_multiplier": FAST_INPUT_PER_MTOK / STANDARD_INPUT_PER_MTOK,
        }
        print("SUMMARY " + json.dumps(summary, indent=2))
    finally:
        remove_probe()
        if old_state is None:
            try:
                STATE_PATH.unlink()
            except FileNotFoundError:
                pass
        else:
            STATE_PATH.write_text(old_state)


if __name__ == "__main__":
    main()
