# Pi Goal

Codex-style persistent `/goal` for [Pi](https://pi.dev/).

Set an objective once, then let Pi keep taking follow-up turns until the agent verifies the work is complete and calls the completion tool.

## What it does

- Adds `/goal`, `/goal pause`, `/goal resume`, and `/goal clear`.
- Persists goal state in the Pi session, so it follows session resume and branch navigation.
- Shows compact goal status in the Pi UI.
- Injects hidden continuation guidance while a goal is active.
- Gives the model `goal_get` and `goal_complete` tools.
- Keeps lifecycle controls user-owned: the model can complete a goal, but cannot pause, resume, clear, or replace it.

## Install

```bash
pi install https://github.com/jaytel0/pi
```

<details>
<summary>Manual install</summary>

```bash
cp -r extensions/pi-goal ~/.pi/agent/extensions/
```

Then `/reload` in pi.

</details>

## Use

```text
/goal                         show the current goal or usage
/goal <objective>             set an active autonomous goal
/goal pause                   pause continuation
/goal resume                  resume and continue when idle
/goal clear                   remove the goal
```

Example:

```text
/goal finish the refactor, run tests, and update docs
```

## Model tools

| Tool | Description |
| --- | --- |
| `goal_get` | Read current goal status, objective, elapsed time, and token usage. |
| `goal_complete` | Mark the active goal complete after auditing concrete evidence. |

`goal_complete` is intentionally the only mutating tool exposed to the model. Pause, resume, clear, and replacement stay under user control through `/goal`.

## How continuation works

When a goal is active and a turn ends, the extension queues a hidden follow-up message with the objective, current usage, and completion-audit instructions. The agent continues working until it can prove the objective is done and calls `goal_complete`.

The completion instructions require concrete evidence. Passing tests or doing substantial work is not enough unless that evidence covers every explicit requirement in the objective.

## Notes

- There is no token budget feature in this extension.
- Goal state is stored with `pi.appendEntry`, so it is part of the session history rather than an external file.
- Use `/goal pause` before switching context if you do not want automatic follow-up turns.

## License

MIT
