# Pi OpenAI Fast Mode

Toggle OpenAI Fast mode in [Pi](https://pi.dev/) for supported GPT models.

This extension sends the same request value Codex uses for `/fast on`:

```json
{ "service_tier": "priority" }
```

## What it does

- Adds `/fast on`, `/fast off`, `/fast toggle`, and `/fast status`.
- Persists the setting in `~/.pi/agent/fast-mode.json`.
- Applies only to OpenAI Responses providers and GPT-5.4/GPT-5.5 model families.
- Shows a `⚡` next to the model name in Pi's footer when Fast mode is active.

## Install

Copy or symlink this directory into Pi's extension folder:

```bash
mkdir -p ~/.pi/agent/extensions
ln -s /path/to/pi-openai-fast-mode ~/.pi/agent/extensions/openai-fast-mode
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
/fast status   show current state and request stats
```

Fast mode only changes requests for supported models. Other providers/models are left untouched.

## Supported models

By default:

- `gpt-5.4`, `gpt-5.4-*`
- `gpt-5.5`, `gpt-5.5-*`

On providers:

- `openai` using `openai-responses`
- `openai-codex` using `openai-codex-responses`

## Important notes

- Server-side entitlement and billing are controlled by OpenAI or your proxy.
- If your endpoint does not support `service_tier: "priority"`, it may ignore the field or return an error.
- With an OpenAI API key, this uses normal API billing. ChatGPT/Codex credit behavior depends on the endpoint you use.
- The lightning-bolt indicator uses Pi's custom footer API, so it may override other custom-footer extensions.

## Verify

Mock integration test:

```bash
cd /path/to/pi-openai-fast-mode
python3 tests/mock-openai-fast-test.py
```

Real endpoint benchmark:

```bash
cd /path/to/pi-openai-fast-mode
OPENAI_API_KEY=... python3 tests/real-endpoint-benchmark.py
```

If your OpenAI endpoint is configured by a Pi provider extension, load it before this extension:

```bash
PI_FAST_TEST_PROVIDER_EXTENSIONS=/path/to/provider-extension.ts \
  python3 tests/real-endpoint-benchmark.py
```

The real benchmark prints redacted token metadata only.

## Why `priority`?

Codex accepts the user-facing value `fast`, but maps it to the OpenAI request value `priority` before sending the Responses API request. This extension injects that request value directly in Pi's `before_provider_request` hook.
