---
name: agent-browser
description: Browser automation CLI for web interaction, scraping, and testing
---

# agent-browser

Browser automation CLI. Headless Chromium is available in this VM.

## Core workflow

1. `agent-browser open <url>` — navigate
2. `agent-browser snapshot -i` — get interactive elements with refs (@e1, @e2...)
3. `agent-browser click @e1` / `agent-browser fill @e2 "text"` — interact by ref
4. Re-snapshot after page changes

## Useful commands

- `agent-browser read <url>` — fetch page as agent-readable text (no browser launch)
- `agent-browser screenshot [path]` — take screenshot
- `agent-browser eval <js>` — run JavaScript in page
- `agent-browser get text @e1` — get element text
- `agent-browser wait --text "Welcome"` — wait for text
- `agent-browser close` — close browser

## Tips

- Always re-snapshot after navigation or clicks that change the page
- Use `snapshot -i` (interactive only) to keep output small
- Use `--json` for machine-readable output
- Use `agent-browser read <url>` for simple text extraction without a full browser session
- Chain commands: `agent-browser open url && agent-browser snapshot -i`
- `agent-browser --help` for full command reference
