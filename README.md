# agent-vm

Lightweight Alpine Linux VMs for coding agents on macOS. Each project gets its own isolated VM — run 2-3 in parallel without breaking a sweat.

~4 GB RAM per VM. [Lima](https://lima-vm.io/) + Apple Virtualization.framework, no QEMU.

## Why?

AI coding agents (like [opencode](https://opencode.ai/)) work best when they can install packages, run builds, and execute arbitrary commands without risk to your host machine. agent-vm gives each project a throwaway Linux sandbox while your Mac stays clean. The Docker-bearing templates additionally remove guest root access and restrict outbound networking. If something goes wrong, just delete the VM and start fresh.

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
agent-vm -t codex     Create with the Codex + Docker template (first run only)
agent-vm --allow-domain HOST
                      Allow one extra HTTPS hostname for this session
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
agent-vm -t codex                          # lima-codex.yaml.template
agent-vm -t codex --allow-domain docs.example.com
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

Same stack as the default, plus rootless Docker Engine and Compose. Uses 6 GiB RAM and 30 GiB disk so image pulls don’t fill the VM immediately.

| Tool | Purpose |
|------|---------|
| Rootless Docker Engine | User-namespaced containers inside the VM |
| Docker Compose | `docker compose` via `docker-cli-compose` |

Docker runs entirely as the login user. There is no root daemon, Docker group,
or reachable `/var/run/docker.sock`, and interactive passwordless sudo is
removed after provisioning. `docker` and `docker compose` remain approval-free.
Host-level privileged containers and the host network namespace are not
available; flags such as `--privileged` or `--network host` remain scoped to
rootless Docker's user/network namespaces.

### Codex template (`agent-vm -t codex`)

The public [`lima-codex.yaml.template`](./lima-codex.yaml.template) includes
[Codex CLI](https://learn.chatgpt.com/docs/codex/cli), rootless Docker Engine and
Compose, Chromium, `agent-browser`, and the bundled `agent-browser` skill.
Codex discovers the read-only skills mount at its standard admin location,
`/etc/codex/skills`.

Codex uses `approval_policy = "never"` and `sandbox_mode =
"danger-full-access"` inside the non-root VM user account. Codex 0.153.4 blocks
Docker Unix sockets in `workspace-write` even when explicitly allowlisted, so
the VM—not Codex's local filesystem sandbox—is the security boundary. Codex's
experimental native network proxy still provides a matching domain allowlist.
A user-owned Unix bridge under `/tmp` connects the Docker CLI to the rootless
daemon's private runtime socket. Docker pull traffic is independently
constrained by the VM's root-owned OS egress boundary.

#### Restricted egress

Both Docker-bearing templates are default-deny:

- A root-owned nftables policy blocks direct IPv4, IPv6, DNS, LAN,
  `host.lima.internal`, and internet access from the login user.
- npm, rootless Docker, builds, and containers use an SSH-tunnelled host
  allowlist proxy. Only HTTPS `CONNECT` on port 443 is supported.
- Built-in destinations are Codex/OpenAI control-plane hosts,
  `registry.npmjs.org`, Docker Hub authentication/registry hosts, and Docker's
  production image CDNs.
- IP literals, private/link-local destinations, plain HTTP forwarding, and
  every unlisted hostname are rejected.

Some npm packages download binaries or source from other hosts in install
scripts. Review the destination, then allow its exact hostname for one session:

```bash
agent-vm -t codex --allow-domain releases.example.com
# Repeat --allow-domain for multiple exact hostnames.
```

The override is validated, applies to Codex's native policy and the outer
proxy, and disappears when the shell exits. It is never written to a template.
`agent-browser` similarly needs a reviewed override for each external site;
guest-local development servers remain reachable.

This is an egress reduction boundary, not data-loss prevention. npm and Docker
Hub host untrusted public content and remain possible limited exfiltration
channels. Package lockfiles, image digests, and dependency review still matter.

#### Codex credentials stay ephemeral

The Codex template is safe to publish because it contains no credentials:

1. On entry, `agent-vm` looks for `${CODEX_HOME:-~/.codex}/auth.json` on the
   Mac and streams it over Lima's SSH connection.
2. The copy exists only in a root-mounted tmpfs at the guest's `~/.codex`; it
   is never baked into the template, mounted from the host, or written to the
   VM disk. Using the normal path also lets Codex expose its generated network
   proxy CA bundle safely to sandboxed package managers.
3. On shell exit, the copy is deleted and the VM is stopped. Any token refresh
   remains in the ephemeral copy and is never synchronized back to the Mac.

This follows Codex's documented
[headless-host authentication pattern](https://learn.chatgpt.com/docs/auth#login-on-headless-devices)
while eliminating credential persistence. Codex itself—and a container it
deliberately mounts the credential into—can read the ephemeral credential
during the active session. Hiding a guest-resident credential is incompatible
with autonomous operation. The host credential file remains the source of
truth and is never modified by the VM.

If the host uses keyring-only storage, no `auth.json` is available to copy; run
`codex login --device-auth` inside the VM for that session, or configure
file-backed host storage first. Treat `~/.codex/auth.json` like a password.

### Custom template (`agent-vm -t custom`)

Same idea as Docker, but the file lives only on your machine. Start from [`lima-custom.yaml.template.example`](./lima-custom.yaml.template.example), customize freely, and create VMs with `-t custom`. Nothing under `lima-custom.yaml.template` is committed.

## opencode config — credentials stay on your Mac

Templates marked `# agent-vm: opencode-broker` (the default, Docker, and custom example) do **not** mount your host OpenCode credentials into the VM. Instead:

1. agent-vm copies a sanitized `~/.config/opencode/` into a cache dir (API keys and auth tokens stripped).
2. Providers that need host credentials (`~/.local/share/opencode/auth.json`, or `options.apiKey` in config) are rewritten to a dummy key whose `baseURL` is a localhost broker.
3. A host-side broker (`opencode-credential-broker.mjs`) injects the real key or GitHub Copilot OAuth token when proxying inference requests.
4. The guest only sees the dummy key; the reverse SSH tunnel is the only path to the real provider.

Local providers without secrets (LAN `baseURL`s, no API key) are left pointing at their original endpoints.

Existing VMs keep their original mounts until you `agent-vm delete` and recreate them.

The agent-vm skills bundled in this repo are still linked in as an additional skills directory.

## VM configuration

Templates live next to the script:

| File | When |
|------|------|
| [`lima.yaml.template`](./lima.yaml.template) | Default (light) |
| [`lima-docker.yaml.template`](./lima-docker.yaml.template) | `agent-vm -t docker` |
| [`lima-codex.yaml.template`](./lima-codex.yaml.template) | `agent-vm -t codex` (Codex + Docker + ephemeral auth) |
| [`lima-custom.yaml.template.example`](./lima-custom.yaml.template.example) | Starter for local custom (copy → `lima-custom.yaml.template`) |
| `lima-custom.yaml.template` | `agent-vm -t custom` (gitignored; create locally) |

When a new VM is created, the chosen template is copied and `{{PROJECT_PATH}}` / `{{SCRIPT_DIR}}` placeholders are substituted at runtime. You're encouraged to edit them — tweak CPU/RAM, add mounts, install extra packages, etc. Or pass `-t` with your own Lima YAML.

Key sections:

- **`cpus` / `memory` / `disk`** — resource limits per VM (default: 2 CPUs, 4 GiB RAM, 10 GiB disk; Docker template: 6 GiB / 30 GiB)
- **`images`** — Alpine Linux cloud images for aarch64 and x86_64
- **`mounts`** — project dir, sanitized opencode config (no host keys), and agent-vm skills
- **`provision.system`** — packages installed as root on first boot
- **`provision.user`** — opencode + opencode-loop installed as the default user; config symlinks set up here

## LLM API keys

The default template can reach the local network; use `host.lima.internal` for
servers on your Mac. The Docker and Codex templates deny LAN and
`host.lima.internal` access by design.

## License

MIT — see [LICENSE](./LICENSE).
