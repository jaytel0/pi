#!/usr/bin/env python3
"""Benchmark this extension against a real OpenAI-compatible endpoint.

Secrets are never printed. Provider extensions can be supplied with:

  PI_FAST_TEST_PROVIDER_EXTENSIONS=/path/to/provider.ts[:/path/to/other.ts]

If omitted, Pi's built-in OpenAI provider is used with OPENAI_API_KEY.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
AGENT_DIR = Path(os.environ.get("PI_CODING_AGENT_DIR", str(Path.home() / ".pi/agent"))).expanduser()
STATE_PATH = AGENT_DIR / "fast-mode.json"
FAST_EXT = Path(os.environ.get("PI_FAST_TEST_EXTENSION", str(ROOT / "index.ts")))
LOGGER_EXT = Path(os.environ.get(
    "PI_FAST_TEST_LOGGER_EXTENSION",
    str(Path.home() / ".pi/pkg/pi-0.73.0/examples/extensions/provider-payload.ts"),
))
MODEL = os.environ.get("PI_FAST_TEST_MODEL", "openai/gpt-5.5")
THINKING = os.environ.get("PI_FAST_TEST_THINKING", "low")
PROMPT = os.environ.get(
    "PI_FAST_TEST_PROMPT",
    "For a latency benchmark, write exactly 180 words about a red kite over a quiet harbor. Do not use markdown.",
)


def provider_extensions() -> list[Path]:
    raw = os.environ.get("PI_FAST_TEST_PROVIDER_EXTENSIONS", "")
    if not raw.strip():
        return []
    return [Path(part).expanduser() for part in raw.split(os.pathsep) if part.strip()]


def set_fast(enabled: bool) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    STATE_PATH.write_text(json.dumps({"enabled": enabled}, indent=2) + "\n", encoding="utf-8")


def summarize_key(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        return "unset"
    return f"set len={len(value)} prefix={value[:4]}… suffix=…{value[-4:]}"


def run_once(enabled: bool, index: int) -> dict:
    set_fast(enabled)
    work = Path(tempfile.mkdtemp(prefix=f"pi-fast-real-{'on' if enabled else 'off'}-{index}-"))
    try:
        (work / ".pi").mkdir(parents=True, exist_ok=True)
        env = os.environ.copy()
        env["PI_OFFLINE"] = "1"

        cmd = ["pi", "--no-extensions"]
        for ext in provider_extensions():
            cmd += ["-e", str(ext)]
        cmd += [
            "-e", str(FAST_EXT),
            "-e", str(LOGGER_EXT),
            "--no-session",
            "--no-context-files",
            "--no-skills",
            "--no-prompt-templates",
            "--model", MODEL,
            "--thinking", THINKING,
            "-p",
            "--no-tools",
            PROMPT,
        ]

        start = time.perf_counter()
        proc = subprocess.run(cmd, cwd=work, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        total_s = time.perf_counter() - start

        payload_path = work / ".pi/provider-payload.log"
        service_tier = None
        payload_model = None
        if payload_path.exists():
            text = payload_path.read_text(encoding="utf-8")
            try:
                payload, _ = json.JSONDecoder().raw_decode(text.lstrip())
                if isinstance(payload, dict):
                    service_tier = payload.get("service_tier")
                    payload_model = payload.get("model")
            except Exception:
                pass

        return {
            "enabled": enabled,
            "index": index,
            "returncode": proc.returncode,
            "total_s": total_s,
            "stdout": proc.stdout.strip(),
            "stderr_tail": proc.stderr.strip().splitlines()[-5:],
            "payload_model": payload_model,
            "payload_service_tier": service_tier,
        }
    finally:
        shutil.rmtree(work, ignore_errors=True)


def mean(values: list[float]) -> float:
    return sum(values) / len(values)


def main() -> int:
    missing = [str(p) for p in [FAST_EXT, LOGGER_EXT, *provider_extensions()] if not p.exists()]
    if missing:
        print("Missing required extension(s):", file=sys.stderr)
        for path in missing:
            print(f"  {path}", file=sys.stderr)
        return 2

    old_state = STATE_PATH.read_text(encoding="utf-8") if STATE_PATH.exists() else None
    try:
        order = [False, True, True, False, False, True, False, True]
        results = [run_once(enabled, i) for i, enabled in enumerate(order, 1)]

        failures = [r for r in results if r["returncode"] != 0]
        standard = [r for r in results if not r["enabled"] and r["returncode"] == 0]
        fast = [r for r in results if r["enabled"] and r["returncode"] == 0]

        summary = {
            "model": MODEL,
            "provider_extensions": [str(p) for p in provider_extensions()],
            "token_sources_redacted": {
                "OPENAI_API_KEY": summarize_key("OPENAI_API_KEY"),
                "PI_PROXY_API_KEY": summarize_key("PI_PROXY_API_KEY"),
            },
            "payload_assertions": {
                "all_fast_runs_sent_priority": bool(fast) and all(r["payload_service_tier"] == "priority" for r in fast),
                "all_standard_runs_omitted_service_tier": bool(standard) and all(r["payload_service_tier"] is None for r in standard),
                "models": sorted({r["payload_model"] for r in results if r["payload_model"]}),
            },
            "timing_summary": None,
            "failures": failures,
            "runs": [
                {**r, "total_s": round(r["total_s"], 3), "stdout": r["stdout"][:120]}
                for r in results
            ],
        }

        if standard and fast:
            standard_mean = mean([r["total_s"] for r in standard])
            fast_mean = mean([r["total_s"] for r in fast])
            summary["timing_summary"] = {
                "standard_mean_total_s": round(standard_mean, 3),
                "fast_mean_total_s": round(fast_mean, 3),
                "speedup_standard_over_fast": round(standard_mean / fast_mean, 2) if fast_mean else None,
            }

        print(json.dumps(summary, indent=2))
        return 0 if not failures else 1
    finally:
        if old_state is None:
            try:
                STATE_PATH.unlink()
            except FileNotFoundError:
                pass
        else:
            STATE_PATH.write_text(old_state, encoding="utf-8")


if __name__ == "__main__":
    raise SystemExit(main())
