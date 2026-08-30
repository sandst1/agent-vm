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
PI_BROKER_GUEST_PORT=43111
PI_BROKER_SCRIPT=""
BROKER_PID=""
BROKER_PORT=""
BROKER_READY_FILE=""
BROKER_LOG_FILE=""

# Resolve real script location (follows symlinks)
SOURCE="$0"
while [ -L "$SOURCE" ]; do
  DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ "$SOURCE" != /* ]] && SOURCE="$DIR/$SOURCE"
done
SCRIPT_DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
DEFAULT_TEMPLATE="$SCRIPT_DIR/lima.yaml.template"
PI_BROKER_SCRIPT="$SCRIPT_DIR/pi-credential-broker.mjs"

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
  local pi_config_path="${2:-}"
  sed \
    -e "s|{{PROJECT_PATH}}|${project_path}|g" \
    -e "s|{{SCRIPT_DIR}}|${SCRIPT_DIR}|g" \
    -e "s|{{USER}}|${USER}|g" \
    -e "s|{{PI_CONFIG_PATH}}|${pi_config_path}|g" \
    "$TEMPLATE"
}

vm_status() {
  local name="$1"
  limactl list --json 2>/dev/null \
    | jq -r "select(.name==\"${name}\") | .status" 2>/dev/null || echo ""
}

vm_exists() {
  local name="$1"
  limactl list -q 2>/dev/null | grep -q "^${name}$"
}

all_agent_vms() {
  limactl list --json 2>/dev/null \
    | jq -r "select(.name | startswith(\"${VM_PREFIX}-\")) | [.name, .status, .dir] | @tsv" 2>/dev/null
}

template_uses_pi_broker() {
  grep -q '^# agent-vm: pi-broker$' "$TEMPLATE"
}

vm_uses_pi_broker() {
  local name="$1"
  limactl list --json 2>/dev/null \
    | jq -e "select(.name==\"${name}\") | .config.env.AGENT_VM_PI_BROKER == \"1\"" >/dev/null 2>&1
}

prepare_pi_config() {
  local name="$1"
  local source_dir="$HOME/.pi/agent"
  local cache_root="${XDG_CACHE_HOME:-$HOME/.cache}/agent-vm/pi"
  local target_dir="$cache_root/$name"
  local tmp_dir

  if [ ! -d "$source_dir" ]; then
    echo "error: host Pi config not found at ${source_dir}" >&2
    exit 1
  fi

  mkdir -p "$cache_root"
  chmod 700 "$cache_root"
  tmp_dir=$(mktemp -d "$cache_root/${name}.XXXXXX")
  chmod 700 "$tmp_dir"

  local sensitive='key|token|secret|password|credential|auth'
  for file in settings.json trust.json; do
    if [ -f "$source_dir/$file" ]; then
      jq "walk(if type == \"object\" then with_entries(select(.key | test(\"${sensitive}\"; \"i\") | not)) else . end)" \
        "$source_dir/$file" > "$tmp_dir/$file"
    fi
  done

  local broker_base="http://127.0.0.1:${PI_BROKER_GUEST_PORT}/provider"
  if [ -f "$source_dir/models.json" ]; then
    jq --arg base "$broker_base" --arg dummy "agent-vm-broker" --arg sensitive "$sensitive" '
      walk(if type == "object" then with_entries(select(.key | test($sensitive; "i") | not)) else . end)
      | .providers = (.providers // {})
      | .providers |= with_entries(
          .key as $id
          | .value = (.value + {
              baseUrl: ($base + "/" + ($id | @uri)),
              apiKey: $dummy
            })
        )
      | .providers["github-copilot"] = ((.providers["github-copilot"] // {}) + {
          baseUrl: ($base + "/github-copilot"),
          apiKey: $dummy
        })
      | .providers.openrouter = ((.providers.openrouter // {}) + {
          baseUrl: ($base + "/openrouter"),
          apiKey: $dummy
        })
    ' "$source_dir/models.json" > "$tmp_dir/models.json"
  else
    jq -n --arg base "$broker_base" --arg dummy "agent-vm-broker" '{
      providers: {
        "github-copilot": {baseUrl: ($base + "/github-copilot"), apiKey: $dummy},
        openrouter: {baseUrl: ($base + "/openrouter"), apiKey: $dummy}
      }
    }' > "$tmp_dir/models.json"
  fi

  {
    jq -r 'keys[]' "$source_dir/auth.json" 2>/dev/null || true
    jq -r '.providers // {} | keys[]' "$source_dir/models.json" 2>/dev/null || true
    printf '%s\n' github-copilot openrouter
  } | sort -u | jq -Rn --arg dummy "agent-vm-broker" '
    [inputs | select(length > 0)] | map({key: ., value: {type: "api_key", key: $dummy}}) | from_entries
  ' > "$tmp_dir/auth.json"
  chmod 600 "$tmp_dir"/*.json

  rm -rf "$target_dir"
  mv "$tmp_dir" "$target_dir"
  echo "$target_dir"
}

start_pi_broker() {
  local runtime_root="${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}"
  BROKER_READY_FILE=$(mktemp "$runtime_root/agent-vm-broker-ready.XXXXXX")
  BROKER_LOG_FILE=$(mktemp "$runtime_root/agent-vm-broker-log.XXXXXX")

  node "$PI_BROKER_SCRIPT" >"$BROKER_READY_FILE" 2>"$BROKER_LOG_FILE" &
  BROKER_PID=$!

  local attempts=0
  while [ ! -s "$BROKER_READY_FILE" ]; do
    if ! kill -0 "$BROKER_PID" 2>/dev/null; then
      echo "error: Pi credential broker failed to start" >&2
      cat "$BROKER_LOG_FILE" >&2
      return 1
    fi
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 100 ]; then
      echo "error: timed out waiting for Pi credential broker" >&2
      return 1
    fi
    sleep 0.05
  done

  BROKER_PORT=$(jq -er '.port' "$BROKER_READY_FILE")
}

stop_pi_broker() {
  if [ -n "$BROKER_PID" ] && kill -0 "$BROKER_PID" 2>/dev/null; then
    kill "$BROKER_PID" 2>/dev/null || true
    wait "$BROKER_PID" 2>/dev/null || true
  fi
  [ -z "$BROKER_READY_FILE" ] || rm -f "$BROKER_READY_FILE"
  [ -z "$BROKER_LOG_FILE" ] || rm -f "$BROKER_LOG_FILE"
  BROKER_PID=""
}

stop_vm_verified() {
  local name="$1"
  local status
  status=$(vm_status "$name")
  [ "$status" = "Running" ] || return 0

  if ! limactl stop "$name"; then
    echo "warning: graceful stop failed for ${name}; forcing stop" >&2
  fi
  status=$(vm_status "$name")
  if [ "$status" = "Running" ]; then
    limactl stop --force "$name"
    status=$(vm_status "$name")
  fi
  if [ "$status" = "Running" ]; then
    echo "error: ${name} is still running after forced stop" >&2
    return 1
  fi
}

# --- Commands ---

cmd_shell() {
  local project_path
  project_path="$(pwd)"

  local vm_name
  vm_name=$(vm_name_for "$project_path")
  local use_pi_broker=false
  local pi_config_path=""

  if vm_exists "$vm_name"; then
    vm_uses_pi_broker "$vm_name" && use_pi_broker=true
  elif template_uses_pi_broker; then
    use_pi_broker=true
  fi

  if [ "$use_pi_broker" = true ]; then
    if [ ! -f "$PI_BROKER_SCRIPT" ]; then
      echo "error: missing Pi credential broker: ${PI_BROKER_SCRIPT}" >&2
      exit 1
    fi
    pi_config_path=$(prepare_pi_config "$vm_name")
  fi

  if ! vm_exists "$vm_name"; then
    local tmpfile
    tmpfile=$(mktemp /tmp/lima-XXXXX.yaml)
    generate_yaml "$project_path" "$pi_config_path" > "$tmpfile"

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
  local shell_status=0
  local cleanup_done=false
  cleanup_shell() {
    local status=$?
    [ "$cleanup_done" = true ] && return
    cleanup_done=true
    trap - EXIT HUP INT TERM
    stop_pi_broker
    echo "Stopping ${vm_name}..."
    stop_vm_verified "$vm_name" || true
    return "$status"
  }
  trap cleanup_shell EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM

  if [ "$use_pi_broker" = true ]; then
    start_pi_broker
    ssh -qt \
      -o ExitOnForwardFailure=yes \
      -R "127.0.0.1:${PI_BROKER_GUEST_PORT}:127.0.0.1:${BROKER_PORT}" \
      -F "$HOME/.lima/${vm_name}/ssh.config" \
      "lima-${vm_name}" -- \
      'mkdir -p ~/.pi/agent; cp /etc/agent-vm-pi/*.json ~/.pi/agent/; chmod 600 ~/.pi/agent/auth.json; cd /workspace; exec bash --login' \
      || shell_status=$?
  else
    ssh -qt -F "$HOME/.lima/${vm_name}/ssh.config" "lima-${vm_name}" -- \
      'cd /workspace; exec bash --login' || shell_status=$?
  fi

  cleanup_shell
  trap - EXIT
  return "$shell_status"
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
    if stop_vm_verified "$target"; then
      echo "Stopped: ${target}"
    else
      exit 1
    fi
  else
    echo "No VM named '${target}'"
    exit 1
  fi
}

cmd_stop_all() {
  local stopped=0
  while IFS=$'\t' read -r name status _dir; do
    if [ "$status" = "Running" ]; then
      if stop_vm_verified "$name"; then
        echo "Stopped: ${name}"
        stopped=$((stopped + 1))
      else
        echo "Failed to stop: ${name}" >&2
      fi
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
  echo "Each project gets its own VM and stops when its shell exits."
  echo "~4 GB RAM per default VM; Docker template uses ~6 GB + 30 GiB disk."
}

# --- Main ---

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
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
fi
