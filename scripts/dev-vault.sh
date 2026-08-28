#!/usr/bin/env bash
# Set up the local dev vault with hot reload.
#
# Creates dev-vault/ (gitignored), installs the community hot-reload plugin
# (https://github.com/pjeby/hot-reload) into it, and pre-enables both plugins.
# Run `bun run dev` afterwards; it builds straight into the vault's plugin
# directory and maintains the .hotreload marker.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VAULT="$ROOT/dev-vault"
PLUGINS="$VAULT/.obsidian/plugins"
HOT_RELOAD_REF="master"

mkdir -p "$PLUGINS/hot-reload" "$PLUGINS/ys-obsidian-agent"

curl -fsSL "https://raw.githubusercontent.com/pjeby/hot-reload/$HOT_RELOAD_REF/main.js" \
  -o "$PLUGINS/hot-reload/main.js"
curl -fsSL "https://raw.githubusercontent.com/pjeby/hot-reload/$HOT_RELOAD_REF/manifest.json" \
  -o "$PLUGINS/hot-reload/manifest.json"

printf '%s\n' '["hot-reload","ys-obsidian-agent"]' > "$VAULT/.obsidian/community-plugins.json"

echo "Dev vault ready at: $VAULT"
echo "1. Run: bun run dev   (builds into the vault and watches)"
echo "2. Open dev-vault as a vault in Obsidian and trust it (community plugins on)."
echo "3. Run the 'Open agent chat' command."
