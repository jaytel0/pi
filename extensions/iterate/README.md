# Iterate

Runs multiple Pi agents in parallel so you can compare results and keep the best one.

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

Start a parallel iteration session:

```text
/iterate
```

Then use:

```text
/iterate-status    show progress
/iterate-serve     preview app results in browsers
/iterate-diff      compare code changes
/iterate-pick      merge, cherry-pick, or keep a winner
/iterate-cleanup   remove iteration worktrees and branches
```

## What it does

- Creates isolated git worktrees from the current `HEAD`.
- Runs multiple Pi agents with the same or different prompts.
- Shows live progress in Pi.
- Starts dev servers for side-by-side review.
- Shows summary/full/cross diffs.
- Merges, cherry-picks, or keeps selected results.

## Notes

- Use this inside a git repo.
- Local changes may be stashed before worktrees are created.
- Iteration metadata is stored in `.pi-iterations/`.
- `.pi-iterations/` is automatically added to `.gitignore`.

## Files

| File | Purpose |
| --- | --- |
| `index.ts` | Commands and orchestration |
| `runner.ts` | Parallel Pi process runner |
| `worktree.ts` | Git worktree and merge helpers |
| `server.ts` | Dev server helpers |
| `widget.ts` | Live progress widget |
