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

When you're done, `exit` the VM shell. agent-vm closes its SSH forwards and stops the VM automatically, so guest workloads and Lima host helpers do not keep consuming resources.

## Commands

```
agent-vm              Enter VM for current directory (creates on first run)
agent-vm -t docker    Create with the Docker template (first run only)
agent-vm -t custom    Create with your local custom template (first run only)
agent-vm list         Show all agent VMs and their status
agent-vm status       Show VM for current directory
agent-vm stop [name]  Stop a VM (default: current dir's VM)
agent-vm stop-all     Stop all agent VMs
agent-vm delete [name] Delete a VM entirely
```

Stop/delete accept shorthand — `agent-vm stop customer-a` works (the `agent-` prefix is added automatically).

### Templates

The default VM stays light ([`lima.yaml.template`](./lima.yaml.template)). Use a different template when creating a VM:

```bash
agent-vm -t docker                         # lima-docker.yaml.template
agent-vm --template lima-docker.yaml.template
agent-vm -t custom                         # lima-custom.yaml.template (local only)
agent-vm -t /path/to/my.yaml               # any Lima YAML
```

`-t` / `--template` only applies on **first create**. If the VM already exists, delete it first to recreate with another template.

#### Local custom template (`agent-vm -t custom`)

For a private image/stack you do not want in git, copy the example and edit it locally:

```bash
cp lima-custom.yaml.template.example lima-custom.yaml.template
# edit lima-custom.yaml.template — packages, images, CPUs/RAM, mounts, …
agent-vm -t custom
```

`lima-custom.yaml.template` is gitignored. The committed starter is [`lima-custom.yaml.template.example`](./lima-custom.yaml.template.example).

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

### Docker template (`agent-vm -t docker`)

Same stack as the default, plus Docker Engine and Compose. Uses 6 GiB RAM and 30 GiB disk so image pulls don’t fill the VM immediately.

| Tool | Purpose |
|------|---------|
| Docker Engine | Containers inside the VM (`docker` CLI + daemon) |
| Docker Compose | `docker compose` via `docker-cli-compose` |

The lima user is added to the `docker` group (no sudo needed for normal use).

### Custom template (`agent-vm -t custom`)

Same idea as Docker, but the file lives only on your machine. Start from [`lima-custom.yaml.template.example`](./lima-custom.yaml.template.example), customize freely, and create VMs with `-t custom`. Nothing under `lima-custom.yaml.template` is committed.

## opencode config — copied from your Mac automatically

> **The default and Docker templates mount `~/.config/opencode/` read-only from your Mac into the VM.** Read-only prevents modification, not credential theft; do not use those templates when host-key isolation is required.

Individual config files are symlinked into `~/.config/opencode/` inside the VM, so opencode sees them exactly as it would on your host. The agent-vm skills bundled in this repo are also linked in as an additional skills directory.

## VM configuration

Templates live next to the script:

| File | When |
|------|------|
| [`lima.yaml.template`](./lima.yaml.template) | Default (light) |
| [`lima-docker.yaml.template`](./lima-docker.yaml.template) | `agent-vm -t docker` |
| [`lima-custom.yaml.template.example`](./lima-custom.yaml.template.example) | Starter for local custom (copy → `lima-custom.yaml.template`) |
| `lima-custom.yaml.template` | `agent-vm -t custom` (gitignored; create locally) |

When a new VM is created, the chosen template is copied and `{{PROJECT_PATH}}` / `{{SCRIPT_DIR}}` placeholders are substituted at runtime. You're encouraged to edit them — tweak CPU/RAM, add mounts, install extra packages, etc. Or pass `-t` with your own Lima YAML.

Key sections:

- **`cpus` / `memory` / `disk`** — resource limits per VM (default: 2 CPUs, 4 GiB RAM, 10 GiB disk; Docker template: 6 GiB / 30 GiB)
- **`images`** — Alpine Linux cloud images for aarch64 and x86_64
- **`mounts`** — project dir, opencode config (read-only), and agent-vm skills
- **`provision.system`** — packages installed as root on first boot
- **`provision.user`** — opencode + opencode-loop installed as the default user; config symlinks set up here

## LLM API keys

VMs are on your local network. LAN IPs work directly. For servers running on your Mac, use `host.lima.internal` from inside the VM.

## License

MIT — see [LICENSE](./LICENSE).
