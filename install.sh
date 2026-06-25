#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LINK_PATH="/usr/local/bin/agent-vm"

for cmd in limactl jq; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "Missing: $cmd — run: brew install lima jq"
    exit 1
  fi
done

if [ -L "$LINK_PATH" ] || [ -f "$LINK_PATH" ]; then
  sudo rm "$LINK_PATH"
fi

sudo ln -s "$SCRIPT_DIR/agent.sh" "$LINK_PATH"
chmod +x "$SCRIPT_DIR/agent.sh"

echo "Installed: agent-vm"
echo ""
echo "Usage:"
echo "  cd ~/projects/something && agent-vm    # create/enter VM"
echo "  cd ~/projects/other && agent-vm        # separate VM"
echo "  agent-vm list                          # see all VMs"
