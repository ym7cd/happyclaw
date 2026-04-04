#!/bin/bash
set -e

AGENT_HOME="${HAPPYCLAW_AGENT_HOME:-/home/node/.claude}"
RUNNER_APP_DIR="${HAPPYCLAW_RUNNER_APP_DIR:-/app}"
RUNNER_DIST_DIR="${HAPPYCLAW_RUNNER_DIST_DIR:-/tmp/dist}"

# Set permissive umask so files created by the container (node user, uid 1000)
# are writable by the host backend (agent user, uid 1002).
# Without this, the host cannot delete/modify files created by the container.
umask 0000

# Fix ownership on mounted volumes.
# Host uid may differ from container node user (uid 1000), especially in
# rootless podman where uid remapping causes EACCES on bind mounts.
# Running as root here so chown works regardless of host uid.
chown -R node:node "$AGENT_HOME" 2>/dev/null || true
chown -R node:node /workspace/group /workspace/global /workspace/memory /workspace/ipc 2>/dev/null || true

# Source environment variables from mounted env file
if [ -f /workspace/env-dir/env ]; then
  set -a
  source /workspace/env-dir/env
  set +a
fi

# Discover and link skills (builtin → project → user, higher priority overwrites)
# Only remove entries that conflict with mounted skills (non-symlink with same name),
# preserving any skills the agent created directly in .claude/skills/.
mkdir -p "$AGENT_HOME/skills"
for dir in /opt/builtin-skills /workspace/project-skills /workspace/user-skills; do
  if [ -d "$dir" ]; then
    for skill in "$dir"/*/; do
      if [ -d "$skill" ]; then
        name=$(basename "$skill")
        target="$AGENT_HOME/skills/$name"
        # Remove conflicting non-symlink entry (e.g. real directory from a failed agent edit)
        if [ -e "$target" ] && [ ! -L "$target" ]; then
          rm -rf "$target" 2>/dev/null || true
        fi
        ln -sfn "$skill" "$target" 2>/dev/null || true
      fi
    done
  fi
done
chown -R node:node "$AGENT_HOME/skills" 2>/dev/null || true

# Compile TypeScript (agent-runner source may be hot-mounted from host)
cd "$RUNNER_APP_DIR" && npx tsc --outDir "$RUNNER_DIST_DIR" 2>&1 >&2
ln -sfn "$RUNNER_APP_DIR/node_modules" "$RUNNER_DIST_DIR/node_modules"
if [ -d "$RUNNER_APP_DIR/prompts" ]; then
  ln -sfn "$RUNNER_APP_DIR/prompts" /tmp/prompts
fi
chmod -R a-w "$RUNNER_DIST_DIR"

# Buffer stdin to file (container requires EOF to flush stdin pipe)
cat > /tmp/input.json
chmod 644 /tmp/input.json

# Fix permissions on exit: Claude Code creates some files with mode 0600
# (e.g. settings.json), which the host backend (agent user) cannot read.
# The trap runs as root after the node process exits.
cleanup() {
  chmod -R a+rwX "$AGENT_HOME" 2>/dev/null || true
  chmod -R a+rwX /workspace/group 2>/dev/null || true
}
trap cleanup EXIT

# Drop privileges and execute agent-runner as node user
runuser -u node -- node "$RUNNER_DIST_DIR/index.js" < /tmp/input.json
