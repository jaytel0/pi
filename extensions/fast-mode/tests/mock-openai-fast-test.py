#!/usr/bin/env python3
import json
import os
import random
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FAST_EXT = Path(os.environ.get("PI_FAST_TEST_EXTENSION", str(ROOT / "index.ts")))
OVERRIDE_EXT = ROOT / "tests/provider-override.ts"

REQUESTS = []
REQUEST_LOCK = threading.Lock()

TEXT = " ".join(f"tok{i:03d}" for i in range(120))
CHUNKS = [TEXT[i:i+24] for i in range(0, len(TEXT), 24)]


def sse(w, event):
    w.write(("data: " + json.dumps(event, separators=(",", ":")) + "\n\n").encode("utf-8"))
    w.flush()


class MockOpenAI(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        return

    def do_POST(self):
        if not self.path.endswith("/responses"):
            self.send_error(404)
            return
        length = int(self.headers.get("content-length", "0"))
        body = self.rfile.read(length).decode("utf-8")
        payload = json.loads(body)
        tier = payload.get("service_tier")
        model = payload.get("model")
        with REQUEST_LOCK:
            REQUESTS.append({"model": model, "service_tier": tier, "path": self.path})

        # Deliberately model a server that honors priority by reducing both queue
        # latency and token cadence. This proves Pi's toggle reaches the provider
        # and affects end-to-end response time when honored by the API.
        priority = tier == "priority"
        initial_delay = 0.08 if priority else 0.70
        per_chunk_delay = 0.006 if priority else 0.045

        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("cache-control", "no-cache")
        self.send_header("connection", "close")
        self.end_headers()

        time.sleep(initial_delay)
        resp_id = f"resp_{int(time.time()*1000)}"
        msg_id = "msg_1"
        sse(self.wfile, {"type": "response.created", "response": {"id": resp_id}})
        sse(self.wfile, {"type": "response.output_item.added", "item": {"id": msg_id, "type": "message", "role": "assistant", "content": [], "status": "in_progress"}})
        sse(self.wfile, {"type": "response.content_part.added", "item_id": msg_id, "output_index": 0, "content_index": 0, "part": {"type": "output_text", "text": "", "annotations": []}})
        emitted = ""
        for chunk in CHUNKS:
            emitted += chunk
            sse(self.wfile, {"type": "response.output_text.delta", "item_id": msg_id, "output_index": 0, "content_index": 0, "delta": chunk})
            time.sleep(per_chunk_delay)
        sse(self.wfile, {"type": "response.output_item.done", "item": {"id": msg_id, "type": "message", "role": "assistant", "content": [{"type": "output_text", "text": emitted, "annotations": []}], "status": "completed"}})
        sse(self.wfile, {"type": "response.completed", "response": {"id": resp_id, "status": "completed", "service_tier": tier or "default", "usage": {"input_tokens": 20, "output_tokens": len(CHUNKS), "total_tokens": 20 + len(CHUNKS), "input_tokens_details": {"cached_tokens": 0}}}})
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


def run_pi(tmp: Path, port: int, enabled: bool, model="gpt-5.5"):
    agent = tmp / "agent"
    work = tmp / "work"
    agent.mkdir(parents=True, exist_ok=True)
    (work / ".pi").mkdir(parents=True, exist_ok=True)
    (agent / "fast-mode.json").write_text(json.dumps({"enabled": enabled}) + "\n")
    env = os.environ.copy()
    env.update({
        "PI_CODING_AGENT_DIR": str(agent),
        "PI_OFFLINE": "1",
        "OPENAI_API_KEY": "test-key-not-sent-to-real-openai",
        "MOCK_OPENAI_BASE_URL": f"http://127.0.0.1:{port}/v1",
    })
    cmd = [
        "pi",
        "--no-extensions",
        "-e", str(FAST_EXT),
        "-e", str(OVERRIDE_EXT),
        "--no-session",
        "--no-context-files",
        "--no-skills",
        "--no-prompt-templates",
        "--model", f"openai/{model}",
        "--thinking", "minimal",
        "-p",
        "--no-tools",
        "Return the provided token stream exactly.",
    ]
    start = time.perf_counter()
    p = subprocess.Popen(cmd, cwd=work, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    first = None
    stdout_parts = []
    while True:
        chunk = p.stdout.read(1)
        if chunk:
            if first is None:
                first = time.perf_counter() - start
            stdout_parts.append(chunk)
            # Drain available data without blocking too long.
            rest = p.stdout.peek() if hasattr(p.stdout, "peek") else b""
            if rest:
                stdout_parts.append(p.stdout.read(len(rest)))
        elif p.poll() is not None:
            break
    stderr = p.stderr.read().decode("utf-8", "replace")
    total = time.perf_counter() - start
    out = b"".join(stdout_parts).decode("utf-8", "replace")
    if p.returncode != 0:
        raise RuntimeError(f"pi failed code={p.returncode}\nstderr={stderr}\nstdout={out[:500]}")
    return {"enabled": enabled, "model": model, "first_s": first, "total_s": total, "stdout_len": len(out)}


def mean(xs):
    return sum(xs) / len(xs)


def main():
    if not FAST_EXT.exists():
        print(f"missing {FAST_EXT}", file=sys.stderr)
        return 2

    server = ThreadingHTTPServer(("127.0.0.1", 0), MockOpenAI)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    tmp = Path(tempfile.mkdtemp(prefix="pi-fast-mode-test-"))
    try:
        # Payload assertions.
        with REQUEST_LOCK:
            REQUESTS.clear()
        off = run_pi(tmp, port, False, "gpt-5.5")
        on = run_pi(tmp, port, True, "gpt-5.5")
        unsupported = run_pi(tmp, port, True, "gpt-5.1")
        with REQUEST_LOCK:
            payloads = list(REQUESTS)

        assert payloads[0]["service_tier"] is None, payloads[0]
        assert payloads[1]["service_tier"] == "priority", payloads[1]
        assert payloads[2]["service_tier"] is None, payloads[2]

        # End-to-end A/B timing against the mock provider.
        runs = []
        order = [False, True] * 4
        random.seed(7)
        random.shuffle(order)
        with REQUEST_LOCK:
            REQUESTS.clear()
        for enabled in order:
            runs.append(run_pi(tmp, port, enabled, "gpt-5.5"))

        standard = [r for r in runs if not r["enabled"]]
        fast = [r for r in runs if r["enabled"]]
        std_total = mean([r["total_s"] for r in standard])
        fast_total = mean([r["total_s"] for r in fast])
        std_first = mean([r["first_s"] for r in standard])
        fast_first = mean([r["first_s"] for r in fast])
        speedup_total = std_total / fast_total
        speedup_first = std_first / fast_first

        assert speedup_total >= 1.20, (std_total, fast_total, runs)
        assert speedup_first >= 1.20, (std_first, fast_first, runs)

        result = {
            "payload_assertions": {
                "off_gpt_5_5_service_tier": payloads[0]["service_tier"],
                "on_gpt_5_5_service_tier": payloads[1]["service_tier"],
                "on_gpt_5_1_service_tier": payloads[2]["service_tier"],
            },
            "timing_summary": {
                "standard_mean_first_s": round(std_first, 3),
                "fast_mean_first_s": round(fast_first, 3),
                "first_token_speedup": round(speedup_first, 2),
                "standard_mean_total_s": round(std_total, 3),
                "fast_mean_total_s": round(fast_total, 3),
                "total_speedup": round(speedup_total, 2),
            },
            "runs": [{k: (round(v, 3) if isinstance(v, float) else v) for k, v in r.items()} for r in runs],
        }
        print(json.dumps(result, indent=2))
        return 0
    finally:
        server.shutdown()
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
