# jaytel0 Pi Extensions

A small collection of extensions for [Pi](https://pi.dev/).

## Install

```bash
pi install https://github.com/jaytel0/pi
```

Then restart Pi or run:

```text
/reload
```

## Extensions

| Extension | What it does |
| --- | --- |
| [`openai-fast-mode`](extensions/openai-fast-mode) | Adds `/fast` for supported OpenAI GPT-5.4/GPT-5.5 models by sending `service_tier: "priority"`. |
| [`iterate`](extensions/iterate) | Runs parallel Pi agents in isolated git worktrees, compares results, previews dev servers, and merges/cherry-picks a winner. |

## Commands

### OpenAI Fast Mode

```text
/fast on
/fast off
/fast toggle
/fast status
```

### Iterate

```text
/iterate
/iterate-status
/iterate-serve
/iterate-diff
/iterate-pick
/iterate-cleanup
```

See each extension folder for details.

## License

MIT
