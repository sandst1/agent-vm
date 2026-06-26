# agent-vm

Lightweight Alpine Linux VMs for coding agents on macOS. Each project gets its own isolated VM — run 2-3 in parallel without breaking a sweat.

~4 GB RAM per VM. Lima + Apple Virtualization.framework, no QEMU.

## Install

```bash
brew install lima jq
cd /path/to/agent-vm
./install.sh
```

## Usage

```bash
cd ~/projects/customer-a
agent-vm                    # creates 'agent-customer-a' VM (~2 min first time)
opencode

# in another terminal
cd ~/projects/customer-b
agent-vm                    # creates 'agent-customer-b' VM, runs in parallel
opencode
```

Each project directory maps to its own VM. The VM name is derived from the directory name (`agent-<dirname>`). Inside the VM your project is always at `~/project` (aliased `~/p`).

## Commands

```
agent-vm              Enter VM for current directory (creates on first run)
agent-vm list         Show all agent VMs and their status
agent-vm status       Show VM for current directory
agent-vm stop [name]  Stop a VM (default: current dir's VM)
agent-vm stop-all     Stop all agent VMs
agent-vm delete [name] Delete a VM entirely
```

Stop names accept shorthand — `agent-vm stop customer-a` works (prefix is added automatically).

## Resource usage

| VMs running | RAM    | Disk (approx) |
|-------------|--------|---------------|
| 1           | ~4 GB  | ~1 GB         |
| 2           | ~8 GB  | ~2 GB         |
| 3           | ~12 GB | ~3 GB         |

Safe to run 2-3 on a 32 GB Mac, 5+ on 64 GB.

## LLM API

VMs are on your local network. LAN IPs work directly. For servers on your Mac, use `host.lima.internal` from inside the VM.

opencode config (`~/.config/opencode/`) is mounted read-only — provider keys carry over automatically.

## What's inside

Alpine Linux 3.23, Node.js, Python 3, git, tmux, ripgrep, fd, curl, jq, build-base, Chromium (headless), agent-browser, opencode, opencode-loop.
