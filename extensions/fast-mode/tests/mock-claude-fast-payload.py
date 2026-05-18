#!/usr/bin/env python3
"""Mock-provider payload test for the smart Pi fast-mode extension's Claude route."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXTENSION = Path(os.environ.get("PI_CLAUDE_FAST_TEST_EXTENSION", str(ROOT / "index.ts")))
OVERRIDE_EXTENSION = ROOT / "tests/anthropic-provider-override.ts"
REQUESTS: list[dict] = []
REQUEST_LOCK = threading.Lock()


def sse(w, event: str, data: dict) -> None:
    w.write(f"event: {event}\n".encode("utf-8"))
    w.write(("data: " + json.dumps(data, separators=(",", ":")) + "\n\n").encode("utf-8"))
    w.flush()


class MockAnthropic(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        return

    def do_POST(self):
        if self.path != "/v1/messages":
            self.send_error(404)
            return
        length = int(self.headers.get("content-length", "0"))
        payload = json.loads(self.rfile.read(length) or b"{}")
        with REQUEST_LOCK:
            REQUESTS.append({"path": self.path, "headers": dict(self.headers), "body": payload})

        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("cache-control", "no-cache")
        self.send_header("connection", "close")
        self.end_headers()

        message_id = "msg_mock"
        sse(self.wfile, "message_start", {
            "type": "message_start",
            "message": {
                "id": message_id,
                "type": "message",
                "role": "assistant",
                "content": [],
                "model": "claude-opus-4-6",
                "stop_reason": None,
                "stop_sequence": None,
                "usage": {"input_tokens": 10, "output_tokens": 1},
            },
        })
        sse(self.wfile, "content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}})
        sse(self.wfile, "content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "OK"}})
        sse(self.wfile, "content_block_stop", {"type": "content_block_stop", "index": 0})
        sse(self.wfile, "message_delta", {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": None}, "usage": {"output_tokens": 2}})
        sse(self.wfile, "message_stop", {"type": "message_stop"})


def run_pi(tmp: Path, port: int, enabled: bool, model: str) -> subprocess.CompletedProcess[str]:
    agent = tmp / f"agent-{enabled}-{model.replace('/', '_')}"
    agent.mkdir(parents=True, exist_ok=True)
    (agent / "settings.json").write_text('{"quietStartup":true,"retry":{"enabled":false}}\n')
    (agent / "fast-mode.json").write_text(json.dumps({"enabled": enabled}) + "\n")
    env = os.environ.copy()
    env.update({
        "PI_CODING_AGENT_DIR": str(agent),
        "ANTHROPIC_API_KEY": "test-key-not-sent-to-real-anthropic",
        "MOCK_ANTHROPIC_BASE_URL": f"http://127.0.0.1:{port}",
        "PI_CLAUDE_FAST_BASE_URL": f"http://127.0.0.1:{port}",
        "PI_CLAUDE_FAST_API_KEY": "test-key-not-sent-to-real-anthropic",
        "PI_CLAUDE_FAST_CUSTOM_HEADERS": "X-Claude-Fast-Test-Session: mock-session\nX-Claude-Fast-Test-Usage: pi-mock-test",
    })
    return subprocess.run([
        "pi",
        "--no-extensions",
        "-e", str(OVERRIDE_EXTENSION),
        "-e", str(EXTENSION),
        "--provider", "anthropic",
        "--model", model,
        "--thinking", "off",
        "--no-tools",
        "--no-session",
        "--mode", "json",
        "--print",
        "--system-prompt", "Answer OK.",
        "OK?",
    ], cwd=tmp, env=env, text=True, capture_output=True, timeout=60)


def main() -> int:
    server = ThreadingHTTPServer(("127.0.0.1", 0), MockAnthropic)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    tmp = Path(tempfile.mkdtemp(prefix="pi-claude-fast-mock-"))
    try:
        with REQUEST_LOCK:
            REQUESTS.clear()
        off = run_pi(tmp, port, False, "claude-opus-4-6")
        on = run_pi(tmp, port, True, "claude-opus-4-6")
        unsupported = run_pi(tmp, port, True, "claude-opus-4-5")
        for proc in (off, on, unsupported):
            if proc.returncode != 0:
                raise RuntimeError(f"pi failed code={proc.returncode}\nstderr={proc.stderr}\nstdout={proc.stdout[:1000]}")
        with REQUEST_LOCK:
            requests = list(REQUESTS)
        assert len(requests) == 3, len(requests)
        off_body, on_body, unsupported_body = [r["body"] for r in requests]
        on_headers = {k.lower(): v for k, v in requests[1]["headers"].items()}
        unsupported_headers = {k.lower(): v for k, v in requests[2]["headers"].items()}
        assert off_body.get("speed") is None, off_body
        assert on_body.get("speed") == "fast", on_body
        assert on_body.get("thinking", {}).get("type") == "adaptive", on_body
        assert "Claude Agent SDK" in on_body.get("system", [{}])[0].get("text", ""), on_body.get("system")
        assert unsupported_body.get("speed") is None, unsupported_body
        assert "fast-mode-2026-02-01" in on_headers.get("anthropic-beta", ""), on_headers.get("anthropic-beta")
        assert on_headers.get("x-app") == "cli", on_headers
        assert "fast-mode-2026-02-01" not in unsupported_headers.get("anthropic-beta", ""), unsupported_headers
        assert unsupported_headers.get("x-app") is None, unsupported_headers
        result = {
            "off_speed": off_body.get("speed"),
            "on_speed": on_body.get("speed"),
            "on_thinking": on_body.get("thinking"),
            "unsupported_speed": unsupported_body.get("speed"),
            "beta_has_fast_mode": "fast-mode-2026-02-01" in on_headers.get("anthropic-beta", ""),
            "x_app": on_headers.get("x-app"),
            "unsupported_beta_has_fast_mode": "fast-mode-2026-02-01" in unsupported_headers.get("anthropic-beta", ""),
            "unsupported_x_app": unsupported_headers.get("x-app"),
        }
        print(json.dumps(result, indent=2))
        return 0
    finally:
        server.shutdown()
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
