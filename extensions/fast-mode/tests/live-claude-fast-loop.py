#!/usr/bin/env python3
"""Run a small live Pi loop against the smart extension's Claude fast route.

This intentionally does not print tokens or full environment values. It uses the
extension's normal ~/.claude/settings.json discovery path.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXTENSION = ROOT / "index.ts"


def redact(text: str) -> str:
    text = re.sub(r"shopify-[A-Za-z0-9._-]+", "shopify-<redacted>", text)
    text = re.sub(r"Bearer\s+[A-Za-z0-9._-]+", "Bearer <redacted>", text)
    return text


def run_once(index: int, total: int) -> dict:
    tmp = Path(tempfile.mkdtemp(prefix="pi-claude-fast-live-"))
    try:
        (tmp / "settings.json").write_text('{"quietStartup":true,"retry":{"enabled":false}}\n')
        (tmp / "fast-mode.json").write_text('{"enabled":true}\n')
        env = os.environ.copy()
        env["PI_CODING_AGENT_DIR"] = str(tmp)
        prompt = f"Fast loop probe {index}/{total}: answer with exactly OK-{index}."
        cmd = [
            "pi",
            "--no-extensions",
            "-e",
            str(EXTENSION),
            "--provider",
            "anthropic",
            "--model",
            "claude-opus-4-6",
            "--thinking",
            "off",
            "--no-tools",
            "--no-session",
            "--mode",
            "json",
            "--print",
            "--system-prompt",
            "Answer the user directly and briefly.",
            prompt,
        ]
        start = time.perf_counter()
        proc = subprocess.run(cmd, cwd=tmp, env=env, text=True, capture_output=True, timeout=120)
        elapsed = time.perf_counter() - start
        stdout = redact(proc.stdout)
        stderr = redact(proc.stderr)
        error = None
        response_text = ""
        status = "success" if proc.returncode == 0 else "failed"
        for line in stdout.splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if event.get("type") == "message_end":
                message = event.get("message", {})
                error = message.get("errorMessage") or error
                content = message.get("content") or []
                response_text = "".join(block.get("text", "") for block in content if isinstance(block, dict))
                if error:
                    status = "rate_limited" if "429" in error else "error"
        return {
            "index": index,
            "status": status,
            "returncode": proc.returncode,
            "elapsed_s": round(elapsed, 3),
            "response": response_text[:120],
            "error": error,
            "stderr_tail": stderr[-500:] if stderr else "",
        }
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main(argv: list[str]) -> int:
    total = int(argv[1]) if len(argv) > 1 else int(os.environ.get("PI_CLAUDE_FAST_LIVE_RUNS", "5"))
    delay = float(os.environ.get("PI_CLAUDE_FAST_LIVE_DELAY", "1.0"))
    results = []
    for i in range(1, total + 1):
        result = run_once(i, total)
        results.append(result)
        print(json.dumps(result, ensure_ascii=False), flush=True)
        if i != total:
            time.sleep(delay)
    summary = {
        "runs": total,
        "successes": sum(1 for r in results if r["status"] == "success"),
        "rate_limited": sum(1 for r in results if r["status"] == "rate_limited"),
        "errors": sum(1 for r in results if r["status"] not in {"success", "rate_limited"}),
        "mean_elapsed_s": round(sum(r["elapsed_s"] for r in results) / len(results), 3) if results else 0,
    }
    print(json.dumps({"summary": summary}, indent=2), flush=True)
    return 0 if summary["errors"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
