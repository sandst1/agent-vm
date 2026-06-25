#!/bin/bash
# agent-vm — lightweight Alpine VMs for coding agents
#
# Each project gets its own VM. Run 2-3 in parallel without
# breaking a sweat (~2GB RAM each).
#
#   cd ~/projects/customer-a && agent-vm       # creates/enters VM
#   cd ~/projects/customer-b && agent-vm       # separate VM
#   agent-vm list                              # see all VMs
#   agent-vm stop customer-a                   # free the RAM

set -e

VM_PREFIX="agent"

# Resolve real script location (follows symlinks)
SOURCE="$0"
while [ -L "$SOURCE" ]; do
  DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ "$SOURCE" != /* ]] && SOURCE="$DIR/$SOURCE"
done
SCRIPT_DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
TEMPLATE="$SCRIPT_DIR/lima.yaml.template"

# --- Helpers ---

vm_name_for() {
  local dir="${1:-$(pwd)}"
  local base
  base=$(basename "$dir")
  # Sanitize: lowercase, replace non-alnum with dash
  echo "${VM_PREFIX}-$(echo "$base" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | sed 's/--*/-/g' | sed 's/-$//')"
}

generate_yaml() {
  local project_path="$1"
  sed \
    -e "s|{{PROJECT_PATH}}|${project_path}|g" \
    -e "s|{{USER}}|${USER}|g" \
    "$TEMPLATE"
}

vm_status() {
  local name="$1"
  limactl list --json 2>/dev/null \
    | jq -r ".[] | select(.name==\"${name}\") | .status" 2>/dev/null || echo ""
}

vm_exists() {
  local name="$1"
  limactl list -q 2>/dev/null | grep -q "^${name}$"
}

all_agent_vms() {
  limactl list --json 2>/dev/null \
    | jq -r ".[] | select(.name | startswith(\"${VM_PREFIX}-\")) | [.name, .status, .dir] | @tsv" 2>/dev/null
}

# --- Commands ---

cmd_shell() {
  local project_path
  project_path="$(pwd)"

  local vm_name
  vm_name=$(vm_name_for "$project_path")

  if ! vm_exists "$vm_name"; then
    local tmpfile
    tmpfile=$(mktemp /tmp/lima-XXXXX.yaml)
    generate_yaml "$project_path" > "$tmpfile"

    echo "Creating agent VM for $(basename "$project_path") (first run, ~2 min)..."
    limactl create --name "$vm_name" --tty=false "$tmpfile" >/dev/null 2>&1
    rm -f "$tmpfile"
    limactl start "$vm_name" >/dev/null 2>&1
  else
    if [ "$(vm_status "$vm_name")" != "Running" ]; then
      echo "Starting $(basename "$project_path")..."
      limactl start "$vm_name" >/dev/null 2>&1
    fi
  fi

  echo "→ ~/project ($(basename "$project_path"))"
  ssh -qt -F "$HOME/.lima/${vm_name}/ssh.config" "lima-${vm_name}" -- 'cd /workspace; exec bash --login'
  clear
}

cmd_stop() {
  local target="$1"

  if [ -z "$target" ]; then
    # Stop the VM for the current directory
    target=$(vm_name_for "$(pwd)")
  elif [[ "$target" != ${VM_PREFIX}-* ]]; then
    # Allow shorthand: "agent-vm stop customer-a" → agent-customer-a
    target="${VM_PREFIX}-${target}"
  fi

  if vm_exists "$target"; then
    limactl stop "$target" 2>/dev/null || true
    echo "Stopped: ${target}"
  else
    echo "No VM named '${target}'"
    exit 1
  fi
}

cmd_stop_all() {
  local stopped=0
  while IFS=$'\t' read -r name status _dir; do
    if [ "$status" = "Running" ]; then
      limactl stop "$name" 2>/dev/null || true
      echo "Stopped: ${name}"
      stopped=$((stopped + 1))
    fi
  done < <(all_agent_vms)

  if [ "$stopped" -eq 0 ]; then
    echo "No running agent VMs."
  fi
}

cmd_delete() {
  local target="$1"

  if [ -z "$target" ]; then
    target=$(vm_name_for "$(pwd)")
  elif [[ "$target" != ${VM_PREFIX}-* ]]; then
    target="${VM_PREFIX}-${target}"
  fi

  if vm_exists "$target"; then
    limactl delete "$target" --force 2>/dev/null || true
    echo "Deleted: ${target}"
  else
    echo "No VM named '${target}'"
    exit 1
  fi
}

cmd_list() {
  local found=0
  printf "%-25s %-10s\n" "VM" "STATUS"
  printf "%-25s %-10s\n" "---" "------"
  while IFS=$'\t' read -r name status _dir; do
    printf "%-25s %-10s\n" "$name" "$status"
    found=$((found + 1))
  done < <(all_agent_vms)

  if [ "$found" -eq 0 ]; then
    echo "(none)"
  fi
  echo ""
  echo "Running: $(all_agent_vms | grep -c Running || true) • Total RAM: ~$(($(all_agent_vms | grep -c Running || true) * 4)) GB"
}

cmd_status() {
  local vm_name
  vm_name=$(vm_name_for "$(pwd)")

  if vm_exists "$vm_name"; then
    echo "VM:      ${vm_name}"
    echo "Status:  $(vm_status "$vm_name")"
    echo "Project: $(pwd)"
  else
    echo "No VM for this directory. Run 'agent-vm' to create one."
  fi
}

# --- Main ---

case "${1:-shell}" in
  shell)    cmd_shell ;;
  stop)     cmd_stop "${2:-}" ;;
  stop-all) cmd_stop_all ;;
  delete)   cmd_delete "${2:-}" ;;
  list|ls)  cmd_list ;;
  status)   cmd_status ;;
  *)
    echo "agent-vm — lightweight Alpine VMs for coding agents"
    echo ""
    echo "  agent-vm              Enter VM for current directory (creates on first run)"
    echo "  agent-vm list         Show all agent VMs and their status"
    echo "  agent-vm status       Show VM for current directory"
    echo "  agent-vm stop [name]  Stop a VM (default: current dir's VM)"
    echo "  agent-vm stop-all     Stop all agent VMs"
    echo "  agent-vm delete [name] Delete a VM entirely"
    echo ""
    echo "Each project gets its own VM. Run 2-3 in parallel."
    echo "~4 GB RAM per VM. Alpine Linux."
    ;;
esac
