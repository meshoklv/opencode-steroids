#!/usr/bin/env bash
# opencode-steroids installer. No build step, no npm install: opencode runs the TypeScript directly.
#
#   ./install.sh                 install globally into ~/.config/opencode
#   ./install.sh --project DIR   install into DIR/.opencode (one project only)
#   ./install.sh --uninstall     remove what this script installed (global, or with --project)
#
# Never overwrites an existing steroids.json or opencode.json.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dest="${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}"
uninstall=0

while [ $# -gt 0 ]; do
  case "$1" in
    --project)   dest="$(cd "${2:?--project needs a directory}" && pwd)/.opencode"; shift 2 ;;
    --uninstall) uninstall=1; shift ;;
    -h|--help)   sed -n '2,8p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ "$uninstall" = 1 ]; then
  rm -rf "$dest/plugin/steroids.ts" "$dest/plugin/lib" "$dest/command/panel.md" "$dest/command/steroids_status.md"
  echo "removed opencode-steroids from $dest (your steroids.json, if any, was left alone)"
  exit 0
fi

# opencode scans plugin/ ONE level deep, so the library lives in plugin/lib/ and is imported by steroids.ts.
mkdir -p "$dest/plugin" "$dest/command"
cp "$here/plugin/steroids.ts" "$dest/plugin/steroids.ts"
rm -rf "$dest/plugin/lib" && cp -r "$here/plugin/lib" "$dest/plugin/lib"
cp "$here"/command/*.md "$dest/command/"

# The three advisor tools need @opencode-ai/plugin; opencode installs whatever the config dir's package.json lists.
if [ ! -e "$dest/package.json" ]; then
  printf '{\n  "dependencies": { "@opencode-ai/plugin": "*" }\n}\n' > "$dest/package.json"
fi

if [ ! -e "$dest/steroids.json" ]; then
  echo "tip: every setting is optional; copy $here/steroids.json to $dest/steroids.json to override defaults"
fi

cat <<MSG
opencode-steroids installed into $dest
  mode      : enforce (default). Switch off any time:  touch ~/.local/state/ocrev/OFF
  try it    : opencode run -m opencode/ling-3.0-flash-free "reply with exactly OK"
  log       : ~/.local/state/ocrev/steroids.jsonl
MSG
