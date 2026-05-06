# pi-iterate — parallel agent orchestration for pi

**[Install](#install)** · **[Usage](#usage)** · **[How it works](#how-it-works)**

*Launch N parallel agent iterations from HEAD, compare the results, merge the winner.*

---

## What's included

| | |
|---|---|
| **Extension** | Commands, live progress widget, dev server management, diff viewer |

### Commands

| Command | Description |
|---------|-------------|
| `/iterate` | Launch N parallel iterations from current HEAD |
| `/iterate-status` | Check progress of running/completed iterations |
| `/iterate-pick` | Choose a winner — merge, cherry-pick, or keep branches |
| `/iterate-serve` | Start dev servers with port probing + health checks + auto-open |
| `/iterate-diff` | Compare iterations — stat, full diff, or cross-diff |
| `/iterate-cleanup` | Remove all worktrees and branches |

### Features

- **Parallel execution** — runs up to 4 concurrent pi agents in isolated git worktrees
- **Flexible prompting** — same prompt for all, base + per-iteration twists, or fully different prompts
- **Live progress widget** — real-time status showing turns, cost, tool calls, and files modified
- **Dev server management** — auto-detects package manager, finds available ports, health checks, auto-opens browser
- **Rich diff viewer** — summary stats, full diffs, and cross-diffs between iterations
- **Smart consolidation** — full merge, cherry-pick specific commits, or keep branches for later
- **Session persistence** — sessions survive pi restarts via `.iterate-meta.json`

---

## Install

```bash
pi install https://github.com/jaytel0/pi
```

<details>
<summary>Manual install</summary>

```bash
cp -r extensions/iterate ~/.pi/agent/extensions/
```

Then `/reload` in pi.

</details>

---

## Usage

### 1. Launch iterations

```
/iterate
```

You'll be asked:
1. **How many iterations** (2–8)
2. **Prompt mode** — same prompt, base + twist, or fully different
3. **Prompts** — enter your instructions

The extension creates isolated git worktrees and spawns parallel pi agents, each working independently on their own branch.

### 2. Monitor progress

The **live widget** above the editor shows real-time status for all iterations:

```
┌─ Iterations from main
│ ● #1 3 turns → edit  $0.0234
│ ● #2 2 turns → thinking...  $0.0189
│ ● #3 4 turns → write  $0.0312
└─
```

Use `/iterate-status` for a detailed breakdown at any time.

### 3. Preview results

```
/iterate-serve
```

Starts dev servers for each iteration with automatic port assignment and health checks. Opens all ready URLs in your browser for side-by-side comparison.

### 4. Compare diffs

```
/iterate-diff
```

Three modes:
- **Summary** — stat overview of all iterations vs base
- **Full diff** — complete diff of one iteration vs base
- **Cross-diff** — diff between any two iterations

### 5. Pick a winner

```
/iterate-pick
```

Choose a winning iteration and how to consolidate:
- **Merge** — merge the entire branch into your base branch
- **Cherry-pick** — select specific commits to apply
- **Keep branch** — preserve the branch for later without merging

You can also keep runner-up branches for reference.

### 6. Clean up

```
/iterate-cleanup
```

Removes all worktrees and branches (except any you chose to keep).

---

## How it works

```
┌──────────────────────────────────┐
│         /iterate                 │
│                                  │
│  1. Stash local changes          │
│  2. Create N git worktrees       │
│  3. Install deps in each         │
│  4. Spawn N pi agents            │
│  5. Stream progress via widget   │
│  6. Summarize results            │
└──────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────┐
│      Parallel Agents             │
│                                  │
│  Agent 1 → worktree/iter-1       │
│  Agent 2 → worktree/iter-2       │
│  Agent 3 → worktree/iter-3       │
│  (up to 4 concurrent)            │
└──────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────┐
│   /iterate-pick                  │
│                                  │
│  • Merge winner into base        │
│  • Cherry-pick specific commits  │
│  • Keep branches for later       │
└──────────────────────────────────┘
```

Each iteration runs in a fully isolated git worktree branching from HEAD. Sessions are identified by a base36-encoded timestamp and persist metadata in `.iterate-meta.json`, allowing resumption across pi restarts.

The `.pi-iterations/` directory is automatically added to `.gitignore`.

---

## Architecture

| File | Purpose |
|------|---------|
| `index.ts` | Commands, message renderers, orchestration |
| `runner.ts` | Parallel pi process spawning with JSON event streaming |
| `server.ts` | Dev server lifecycle, port management, health checks |
| `widget.ts` | Live terminal UI with status bars and cost tracking |
| `worktree.ts` | Git worktree create/remove/merge/cherry-pick/diff |

---

## License

MIT
