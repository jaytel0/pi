# Computer Use

Expose Codex-installed macOS Computer Use tools inside [Pi](https://pi.dev/).

This extension lets any Pi model control allowed Mac apps through the same Computer Use installation that Codex Desktop uses.

## What it does

- Starts Codex app-server as a local bridge.
- Creates an ephemeral Codex thread for Computer Use MCP calls.
- Registers Computer Use tools directly in Pi.
- Routes tool calls through Codex's bundled `computer-use` MCP server so macOS launch constraints are satisfied.
- Does not add Pi-side permission prompts.

## Requirements

- macOS.
- Codex Desktop/CLI installed at `/Applications/Codex.app`.
- Codex's bundled Computer Use plugin installed and enabled.
- macOS permissions already granted for Codex Computer Use.

If Codex lives somewhere else, set:

```bash
PI_COMPUTER_USE_CODEX_BIN=/path/to/codex
```

## Install

```bash
pi install https://github.com/jaytel0/pi
```

Then restart Pi or run:

```text
/reload
```

## Tools

| Tool | Description |
| --- | --- |
| `computer_use_list_apps` | List running and recently used apps Computer Use can see. |
| `computer_use_get_app_state` | Inspect an app window and return screenshot/accessibility state. |
| `computer_use_click` | Click an element or pixel coordinate. |
| `computer_use_type_text` | Type literal text into the active app context. |
| `computer_use_press_key` | Press a key or shortcut. |
| `computer_use_scroll` | Scroll an accessibility element. |
| `computer_use_drag` | Drag between pixel coordinates. |
| `computer_use_set_value` | Set an accessibility element value. |
| `computer_use_perform_secondary_action` | Invoke a secondary accessibility action. |

## Commands

```text
/computer-use-status    show bridge status
/computer-use-restart   restart the Codex app-server bridge
/computer-use-tools     list registered Computer Use tools
```

## Usage notes

- Call `computer_use_list_apps` if you need the exact app name or bundle identifier.
- Call `computer_use_get_app_state` before controlling an app.
- Prefer a fresh browser tab for unrelated browser tasks.
- The extension intentionally has no Pi-side permission dialog; use Computer Use only in environments where you trust the active model and prompt.

## How it works

Launching Codex Computer Use's raw MCP binary from an arbitrary parent process can be blocked by macOS AMFI launch constraints. This extension avoids that by spawning:

```bash
/Applications/Codex.app/Contents/Resources/codex app-server --listen stdio://
```

Pi then calls Codex app-server's `mcpServer/tool/call` method for the `computer-use` server.

## License

MIT
