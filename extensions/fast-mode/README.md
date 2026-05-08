# Pi Smart Fast Mode

One Pi extension that makes `/fast` a smart toggle across the currently selected model.

## Behavior

When Fast mode is enabled:

- **Claude Opus 4.6 only** on Anthropic-compatible providers uses the Claude Code fast lane:
  - routes supported Opus 4.6 requests through the configured Shopify Claude Code proxy
  - injects `speed: "fast"`
  - injects adaptive thinking and the Claude Agent SDK identity block required by that route
  - registers Claude Code beta headers, including `fast-mode-2026-02-01`
- **Supported Codex/OpenAI models** use the Codex-style fast request value:
  - injects `service_tier: "priority"` for GPT-5.4/GPT-5.5 Responses requests
- **Unsupported models are left untouched.** This is especially important for Claude: Sonnet and non-4.6 Opus models are not routed or mutated.

The footer shows a yellow `⚡` whenever Fast mode is toggled on, even if the current model is unsupported. Use `/fast status` to see whether the current model is actively using Claude fast, Codex priority, or is unsupported.

## Commands

```text
/fast on
/fast off
/fast toggle
/fast status
/fast reload-provider
```

The old `/claude-fast` command/extension has been removed; use `/fast` for both supported Claude and Codex/OpenAI models.

## State

State is stored in:

```text
~/.pi/agent/fast-mode.json
```

Only the unified state file is used. The retired Claude-only state file (`~/.pi/agent/claude-fast-mode.json`) is no longer read.

## Claude proxy configuration

Claude fast mode reads Shopify Claude Code proxy settings from `~/.claude/settings.json`:

- `apiKeyHelper`
- `env.ANTHROPIC_BASE_URL`
- `env.ANTHROPIC_CUSTOM_HEADERS`

Environment overrides for tests/experiments:

- `PI_CLAUDE_FAST_BASE_URL`
- `PI_CLAUDE_FAST_API_KEY`
- `PI_CLAUDE_FAST_CUSTOM_HEADERS`

Tokens are never printed.

## Supported models

Claude:

- `claude-opus-4-6` / Opus 4.6 variants only

Codex/OpenAI:

- `gpt-5.4`, `gpt-5.4-*`
- `gpt-5.5`, `gpt-5.5-*`

on providers using `openai-responses` or `openai-codex-responses`.

## Tests

```bash
cd ~/.pi/agent/extensions/fast-mode
python3 tests/mock-openai-fast-test.py
python3 tests/mock-claude-fast-payload.py
```
