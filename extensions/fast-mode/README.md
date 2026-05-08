# Pi Fast Mode

A Pi extension that makes `/fast` a smart toggle for supported Codex/OpenAI models.

## Behavior

When Fast mode is enabled, supported GPT-5.4/GPT-5.5 Responses requests get:

```json
{
  "service_tier": "priority"
}
```

Unsupported models are left untouched.

## Commands

```text
/fast on
/fast off
/fast toggle
/fast status
```

## State

State is stored in:

```text
~/.pi/agent/fast-mode.json
```

## Supported models

- `gpt-5.4`, `gpt-5.4-*`
- `gpt-5.5`, `gpt-5.5-*`

on providers using `openai-responses` or `openai-codex-responses`.

## Tests

```bash
cd ~/.pi/agent/extensions/fast-mode
python3 tests/mock-openai-fast-test.py
```
