# agent-vm

Lightweight Alpine Linux VMs for coding agents on macOS. Each project gets its own isolated VM — run 2-3 in parallel without breaking a sweat.

~4 GB RAM per VM. [Lima](https://lima-vm.io/) + Apple Virtualization.framework, no QEMU.

## Why?

AI coding agents (like [opencode](https://opencode.ai/)) work best when they can install packages, run builds, and execute arbitrary commands without risk to your host machine. agent-vm gives each project a throwaway Linux sandbox: the agent gets full root access inside the VM while your Mac stays clean. If something goes wrong, just delete the VM and start fresh.

This is an example setup for **folder-scoped VMs on Mac** — one VM per folder, named after the directory. The folder you `cd` into is what gets mounted, so you choose the scope: a single project, a monorepo, or a top-level `~/projects` directory that contains everything. How many VMs you run and what each one sees is entirely up to you.

## How it works

1. You `cd` into any directory on your Mac and run `agent-vm`.
2. agent-vm creates (or starts) a small Alpine Linux VM named after that directory — e.g. `~/projects/customer-a` becomes the VM `agent-customer-a`.
3. That directory is mounted into the VM at `~/project` (also aliased as `~/p`), so file changes sync both ways.
4. You're dropped into a shell inside the VM, ready to run your coding agent.

The directory you choose sets the scope of the VM. Run from a single project folder for tight isolation, from a monorepo root to give the agent visibility across all packages, or from `~/projects` to share everything with one VM. You're in control.

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

## What's inside each VM

Alpine Linux 3.23 with:

| Tool | Purpose |
|------|---------|
| Node.js, npm | JavaScript runtime |
| Python 3 | Scripting and agent tooling |
| git, curl, jq | Essentials |
| bash, tmux | Shell and terminal multiplexing |
| ripgrep, fd | Fast file search |
| build-base | gcc, make, and friends for native compilation |
| Chromium (headless) | Browser automation |
| [agent-browser](https://github.com/nicepkg/agent-browser) | Browser MCP server for coding agents |
| [opencode](https://opencode.ai/) | AI coding agent |
| opencode-loop | Autonomous loop runner for opencode |

## opencode config — copied from your Mac automatically

> **Your `~/.config/opencode/` directory is mounted read-only from your Mac into the VM.** All provider API keys and opencode settings carry over automatically — no extra setup needed.

Individual config files are symlinked into `~/.config/opencode/` inside the VM, so opencode sees them exactly as it would on your host. The agent-vm skills bundled in this repo are also linked in as an additional skills directory.

## VM configuration

VM configuration lives in [`lima.yaml.template`](./lima.yaml.template). When a new VM is created, this template is copied and `{{PROJECT_PATH}}` / `{{SCRIPT_DIR}}` placeholders are substituted at runtime. You're encouraged to edit it — tweak CPU/RAM, add mounts, install extra packages, etc.

Key sections:

- **`cpus` / `memory` / `disk`** — resource limits per VM (default: 2 CPUs, 4 GiB RAM, 10 GiB disk)
- **`images`** — Alpine Linux cloud images for aarch64 and x86_64
- **`mounts`** — project dir, opencode config (read-only), and agent-vm skills
- **`provision.system`** — packages installed as root on first boot
- **`provision.user`** — opencode + opencode-loop installed as the default user; config symlinks set up here

## LLM API keys

VMs are on your local network. LAN IPs work directly. For servers running on your Mac, use `host.lima.internal` from inside the VM.

## License

MIT — see [LICENSE](./LICENSE).
