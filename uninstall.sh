#!/usr/bin/env bash

set -euo pipefail

if ! command -v codex >/dev/null 2>&1; then
  printf 'Required command not found: codex\n' >&2
  exit 1
fi

if ! codex plugin remove 'capacity-guard@personal'; then
  printf 'Codex could not remove capacity-guard.\n' >&2
  exit 1
fi

printf 'Capacity Guard was disabled and removed from the Codex installation cache.\n'
printf 'Plugin source and personal marketplace entry were preserved for recovery or reinstall.\n'
