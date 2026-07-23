#!/bin/bash
# agent-vm — lightweight Alpine VMs for coding agents
#
# Each project gets its own VM. Run 2-3 in parallel without
# breaking a sweat (~2GB RAM each).
#
#   cd ~/projects/customer-a && agent-vm       # creates/enters VM
#   cd ~/projects/customer-b && agent-vm       # separate VM
#   agent-vm -t docker                         # create with Docker template
#   agent-vm -t custom                         # create with local custom template
#   agent-vm list                              # see all VMs
#   agent-vm stop customer-a                   # free the RAM

set -e

VM_PREFIX="agent"
TEMPLATE_ARG=""

# Resolve real script location (follows symlinks)
SOURCE="$0"
while [ -L "$SOURCE" ]; do
  DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ "$SOURCE" != /* ]] && SOURCE="$DIR/$SOURCE"
done
SCRIPT_DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
DEFAULT_TEMPLATE="$SCRIPT_DIR/lima.yaml.template"

# --- Arg parsing (global flags) ---

ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    -t|--template)
      if [ -z "${2:-}" ]; then
        echo "error: $1 requires a template name or path" >&2
        exit 1
      fi
      TEMPLATE_ARG="$2"
      shift 2
      ;;
    --template=*)
      TEMPLATE_ARG="${1#*=}"
      shift
      ;;
    -h|--help)
      ARGS=(help)
      shift
      ;;
    *)
      ARGS+=("$1")
      shift
      ;;
  esac
done
if [ ${#ARGS[@]} -gt 0 ]; then
  set -- "${ARGS[@]}"
else
  set --
fi

# --- Helpers ---

resolve_template() {
  local arg="${1:-}"
  local candidate

  if [ -z "$arg" ]; then
    echo "$DEFAULT_TEMPLATE"
    return
  fi

  # Absolute / relative path that exists
  if [ -f "$arg" ]; then
    # shellcheck disable=SC2164
    (cd "$(dirname "$arg")" && echo "$(pwd)/$(basename "$arg")")
    return
  fi

  # Bare path under the agent-vm directory
  if [ -f "$SCRIPT_DIR/$arg" ]; then
    echo "$SCRIPT_DIR/$arg"
    return
  fi

  # Shorthand: -t docker → lima-docker.yaml.template
  #             -t custom → lima-custom.yaml.template (local, gitignored)
  for candidate in \
    "$SCRIPT_DIR/lima-${arg}.yaml.template" \
    "$SCRIPT_DIR/${arg}.yaml.template" \
    "$SCRIPT_DIR/lima-${arg}.yaml" \
    "$SCRIPT_DIR/${arg}.yaml"
  do
    if [ -f "$candidate" ]; then
      echo "$candidate"
      return
    fi
  done

  echo "error: template not found: ${arg}" >&2
  echo "Tried: path, ${SCRIPT_DIR}/${arg}, lima-${arg}.yaml.template" >&2
  exit 1
}

TEMPLATE="$(resolve_template "$TEMPLATE_ARG")"

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
    -e "s|{{SCRIPT_DIR}}|${SCRIPT_DIR}|g" \
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
    echo "  template: $(basename "$TEMPLATE")"
    limactl create --name "$vm_name" --tty=false "$tmpfile" >/dev/null 2>&1
    rm -f "$tmpfile"
    limactl start "$vm_name" >/dev/null 2>&1
  else
    if [ -n "$TEMPLATE_ARG" ]; then
      echo "note: VM already exists; --template is ignored (delete first to recreate)" >&2
    fi
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

cmd_help() {
  echo "agent-vm — lightweight Alpine VMs for coding agents"
  echo ""
  echo "  agent-vm              Enter VM for current directory (creates on first run)"
  echo "  agent-vm -t docker    Create with Docker template (first run only)"
  echo "  agent-vm -t custom    Create with local custom template (first run only)"
  echo "  agent-vm list         Show all agent VMs and their status"
  echo "  agent-vm status       Show VM for current directory"
  echo "  agent-vm stop [name]  Stop a VM (default: current dir's VM)"
  echo "  agent-vm stop-all     Stop all agent VMs"
  echo "  agent-vm delete [name] Delete a VM entirely"
  echo ""
  echo "Templates (used only when creating a new VM):"
  echo "  -t, --template NAME   lima.yaml.template (default), docker, custom, or a path"
  echo "                        Shorthand: docker → lima-docker.yaml.template"
  echo "                                   custom → lima-custom.yaml.template"
  echo ""
  echo "Each project gets its own VM. Run 2-3 in parallel."
  echo "~4 GB RAM per default VM; Docker template uses ~6 GB + 30 GiB disk."
}

# --- Main ---

case "${1:-shell}" in
  shell)    cmd_shell ;;
  stop)     cmd_stop "${2:-}" ;;
  stop-all) cmd_stop_all ;;
  delete)   cmd_delete "${2:-}" ;;
  list|ls)  cmd_list ;;
  status)   cmd_status ;;
  help)     cmd_help ;;
  *)
    cmd_help
    ;;
esac
