---
name: agent-browser
description: Browser automation CLI for web interaction, scraping, and testing
---

# agent-browser

Browser automation CLI. Headless Chromium is available in this VM.

## Network boundary

External sites are denied by default in Docker-bearing agent VMs. Before
launching the VM, review each target and allow its exact HTTPS hostname for
that session:

```bash
agent-vm -t codex --allow-domain example.com
```

Repeat `--allow-domain` for page assets hosted on other reviewed domains. The
override expires when the VM shell exits. IP literals, private/LAN targets, and
plain HTTP remain blocked. Guest-local development servers are available
without an override.

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

## Long-running servers (Vite, etc.)

Agent shell commands may kill background jobs when the command ends. Do **not** use `&`, `nohup`, or `disown` for dev servers. Use **tmux** instead.

**Start** (idempotent):

```bash
tmux has-session -t vite 2>/dev/null || tmux new-session -d -s vite 'cd /workspace && npm run dev'
# wait until HTTP responds (adjust port if needed)
for i in 1 2 3 4 5 6 7 8 9 10; do
  curl -sf -o /dev/null http://localhost:3000/ && break
  sleep 1
done
```

**Stop**:

```bash
tmux kill-session -t vite 2>/dev/null || true
```

**Logs**: `tmux capture-pane -t vite -p`

## Tips

- Always re-snapshot after navigation or clicks that change the page
- Use `snapshot -i` (interactive only) to keep output small
- Use `--json` for machine-readable output
- Use `agent-browser read <url>` for simple text extraction without a full browser session
- Chain commands: `agent-browser open url && agent-browser snapshot -i`
- Screenshot: `agent-browser screenshot /tmp/shot.png` (path positional — avoid inventing `--url` flags)
- Close when done: `agent-browser close`
- `agent-browser --help` for full command reference
