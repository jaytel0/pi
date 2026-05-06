# OpenAI Fast Mode

Adds `/fast` to Pi for supported OpenAI GPT models.

## Install

Install the full extension collection:

```bash
pi install https://github.com/jaytel0/pi
```

Then restart Pi or run:

```text
/reload
```

## Use

```text
/fast on       enable Fast mode
/fast off      disable Fast mode
/fast toggle   toggle Fast mode
/fast status   show current state
```

When Fast mode is active for the current model, Pi shows `⚡` next to the model name.

## What it does

- Sends `service_tier: "priority"` on supported OpenAI Responses requests.
- Persists state in `~/.pi/agent/fast-mode.json`.
- Leaves unsupported models and providers unchanged.

## Supported models

- `openai/gpt-5.4*`
- `openai/gpt-5.5*`
- `openai-codex/gpt-5.4*`
- `openai-codex/gpt-5.5*`

## Notes

- OpenAI or your proxy controls entitlement, speed, and billing.
- If an endpoint does not support `service_tier: "priority"`, it may ignore it or return an error.
- The `⚡` indicator uses Pi's custom footer API, so it can override other custom-footer extensions.

## Test

```bash
cd extensions/openai-fast-mode
python3 tests/mock-openai-fast-test.py
```

For a real endpoint benchmark:

```bash
OPENAI_API_KEY=... python3 tests/real-endpoint-benchmark.py
```

## Why `priority`?

Codex exposes this as `/fast`, but sends `service_tier: "priority"` to the Responses API. This extension applies the same request field in Pi.
