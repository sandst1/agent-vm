# agent-vm

Lightweight Alpine Linux VMs for coding agents on macOS. Each project gets its own isolated VM — run 2-3 in parallel without breaking a sweat.

~4 GB RAM per VM. [Lima](https://lima-vm.io/) + Apple Virtualization.framework, no QEMU.

## Why?

AI coding agents (like [opencode](https://opencode.ai/)) work best when they can install packages, run builds, and execute arbitrary commands without risk to your host machine. agent-vm gives each project a throwaway Linux sandbox: the agent gets full root access inside the VM while your Mac stays clean. If something goes wrong, just delete the VM and start fresh.

## How it works

1. You `cd` into a project directory on your Mac and run `agent-vm`.
2. agent-vm creates (or starts) a small Alpine Linux VM named after that directory — e.g. `~/projects/customer-a` becomes the VM `agent-customer-a`.
3. Your project directory is mounted into the VM at `~/project` (also aliased as `~/p`), so file changes sync both ways.
4. You're dropped into a shell inside the VM, ready to run your coding agent.

Under the hood, agent-vm uses [Lima](https://lima-vm.io/) — a tool that launches Linux virtual machines on macOS with automatic file sharing and port forwarding. Lima uses Apple's native Virtualization.framework (on Apple Silicon Macs), so VMs are fast and lightweight with no need for QEMU or Docker.

## Prerequisites

- macOS (Apple Silicon or Intel)
- [Homebrew](https://brew.sh/)

## Install

```bash
brew install lima jq
cd /path/to/agent-vm
./install.sh
```

This installs the `agent-vm` command globally (symlinked to `/usr/local/bin/agent-vm`).

## Getting started

```bash
# Navigate to any project you want to work on
cd ~/projects/my-app

# Launch a VM for this project (~2 minutes the first time, instant after that)
agent-vm

# You're now inside the VM — your project files are at ~/project
cd ~/project
opencode          # start the AI coding agent
```

Want to work on a second project at the same time? Open another terminal:

```bash
cd ~/projects/other-app
agent-vm          # creates a separate VM, runs in parallel
opencode
```

When you're done, just `exit` the VM shell. The VM keeps running in the background so re-entering is instant. Stop it to free RAM when you don't need it anymore.

## Commands

```
agent-vm              Enter VM for current directory (creates on first run)
agent-vm list         Show all agent VMs and their status
agent-vm status       Show VM for current directory
agent-vm stop [name]  Stop a VM (default: current dir's VM)
agent-vm stop-all     Stop all agent VMs
agent-vm delete [name] Delete a VM entirely
```

Stop/delete accept shorthand — `agent-vm stop customer-a` works (the `agent-` prefix is added automatically).

## Resource usage

| VMs running | RAM    | Disk (approx) |
|-------------|--------|---------------|
| 1           | ~4 GB  | ~1 GB         |
| 2           | ~8 GB  | ~2 GB         |
| 3           | ~12 GB | ~3 GB         |

Safe to run 2-3 on a 32 GB Mac, 5+ on 64 GB.

## LLM API keys

VMs are on your local network. LAN IPs work directly. For servers running on your Mac, use `host.lima.internal` from inside the VM.

Your opencode config (`~/.config/opencode/`) is mounted read-only into the VM, so provider API keys carry over automatically — no extra setup needed.

## What's inside each VM

Alpine Linux 3.23 with: Node.js, Python 3, git, bash, tmux, ripgrep, fd, curl, jq, build-base (gcc/make), Chromium (headless), [agent-browser](https://github.com/nicepkg/agent-browser), [opencode](https://opencode.ai/), and opencode-loop.
