#!/usr/bin/env bash

set -euo pipefail

plugin_id="capacity-guard"
locale="auto"
target_root="${HOME:?HOME is not set}/plugins"

usage() {
  cat <<'EOF'
Usage: ./install.sh [options]

Options:
  --locale auto|ja|en   UI display-name language (default: auto)
  --target-root PATH    Plugin destination root (default: $HOME/plugins)
  -h, --help            Show this help
EOF
}

require_value() {
  if [[ $# -lt 2 || -z "$2" ]]; then
    printf 'Missing value for %s.\n' "$1" >&2
    exit 2
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --locale)
      require_value "$@"
      locale="$2"
      shift 2
      ;;
    --target-root)
      require_value "$@"
      target_root="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

case "$locale" in
  auto|ja|en) ;;
  *)
    printf 'Invalid locale: %s (expected auto, ja, or en).\n' "$locale" >&2
    exit 2
    ;;
esac

for required_command in node codex; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    printf 'Required command not found: %s\n' "$required_command" >&2
    exit 1
  fi
done

source_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
mkdir -p -- "$target_root"
resolved_target_root="$(CDPATH= cd -- "$target_root" && pwd -P)"
target_plugin="$resolved_target_root/$plugin_id"
target_parent="$(dirname -- "$target_plugin")"

if [[ "$target_parent" != "$resolved_target_root" ]]; then
  printf 'Refusing to install outside the requested target root: %s\n' "$target_plugin" >&2
  exit 1
fi

for required_file in \
  ".codex-plugin/plugin.json" \
  "skills/capacity-guard/agents/openai.yaml"; do
  if [[ ! -f "$source_root/$required_file" ]]; then
    printf 'Required plugin file not found: %s\n' "$source_root/$required_file" >&2
    exit 1
  fi
done

if [[ "$locale" == "auto" ]]; then
  locale_hint="${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}"
  case "$locale_hint" in
    ja|ja_*|ja-*) locale="ja" ;;
    *) locale="en" ;;
  esac
fi

if [[ "$locale" == "ja" ]]; then
  display_name="使いすぎ防止モード"
else
  display_name="Capacity Guard"
fi

if [[ "$source_root" != "$target_plugin" ]]; then
  if [[ -e "$target_plugin" ]]; then
    backup="$target_plugin.backup.$(date -u +%Y%m%dT%H%M%SZ)"
    if [[ -e "$backup" ]]; then
      backup="$backup.$$"
    fi
    mv -- "$target_plugin" "$backup"
    printf 'Previous installation moved to: %s\n' "$backup"
  fi
  cp -R -- "$source_root" "$target_plugin"
fi

manifest_path="$target_plugin/.codex-plugin/plugin.json"
skill_ui_path="$target_plugin/skills/capacity-guard/agents/openai.yaml"

node - "$manifest_path" "$skill_ui_path" "$display_name" <<'NODE'
const fs = require('node:fs');

const [manifestPath, skillUiPath, displayName] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));

if (!manifest.interface || typeof manifest.interface !== 'object') {
  throw new Error('plugin.json is missing interface metadata.');
}

manifest.interface.displayName = displayName;
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

const skillUi = fs.readFileSync(skillUiPath, 'utf8');
const displayNamePattern = /^(\s*display_name:\s*).*$/m;
if (!displayNamePattern.test(skillUi)) {
  throw new Error('openai.yaml is missing display_name.');
}

const yamlString = JSON.stringify(displayName);
fs.writeFileSync(
  skillUiPath,
  skillUi.replace(displayNamePattern, `$1${yamlString}`),
  'utf8',
);
NODE

marketplace_path="$HOME/.agents/plugins/marketplace.json"
mkdir -p -- "$(dirname -- "$marketplace_path")"

resolved_home="$(CDPATH= cd -- "$HOME" && pwd -P)"
default_plugin_root="$resolved_home/plugins"
if [[ "$resolved_target_root" == "$default_plugin_root" ]]; then
  marketplace_source="./plugins/capacity-guard"
else
  marketplace_source="$target_plugin"
fi

node - "$marketplace_path" "$plugin_id" "$marketplace_source" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const [marketplacePath, pluginId, marketplaceSource] = process.argv.slice(2);
let marketplace;

if (fs.existsSync(marketplacePath)) {
  marketplace = JSON.parse(fs.readFileSync(marketplacePath, 'utf8').replace(/^\uFEFF/, ''));
} else {
  marketplace = {
    name: 'personal',
    interface: { displayName: 'Personal' },
    plugins: [],
  };
}

if (!Array.isArray(marketplace.plugins)) {
  throw new Error('marketplace.json has no plugins array.');
}

marketplace.plugins = marketplace.plugins.filter((entry) => entry?.name !== pluginId);
marketplace.plugins.push({
  name: pluginId,
  source: {
    source: 'local',
    path: marketplaceSource.split(path.sep).join('/'),
  },
  policy: {
    installation: 'AVAILABLE',
    authentication: 'ON_INSTALL',
  },
  category: 'Productivity',
});

fs.writeFileSync(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`, 'utf8');
NODE

codex plugin remove "$plugin_id@personal" >/dev/null 2>&1 || true
if ! codex plugin add "$plugin_id@personal"; then
  printf 'Codex could not install %s from the personal marketplace.\n' "$plugin_id" >&2
  exit 1
fi

printf 'Installed %s (%s), locale=%s\n' "$display_name" "$plugin_id" "$locale"
printf 'Restart Codex before using the plugin in a new task.\n'
