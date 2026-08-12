<div align="center">

# Capacity Guard

**A Codex plugin that safely stops long-running work at a chosen remaining-quota threshold.**

It confirms the current quota and stop threshold before activation and prevents a task tree from continuing new work after a reset.

[日本語](README.md)

[![Latest release](https://img.shields.io/github/v/release/brumelight/codex-capacity-guard?display_name=tag&sort=semver)](https://github.com/brumelight/codex-capacity-guard/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-informational)](LICENSE)

</div>

---

## Overview

Capacity Guard is a quota safety mechanism for long-running Codex tasks, Goals, and parallel agent work.

When the accepted remaining-quota threshold, a recovery to 100%, or an observation failure is detected, it lets already-started indivisible operations converge and blocks new tools, spawns, follow-ups, and next tasks. It does not change the model or reasoning effort.

## Features

- **1% threshold increments** — Accept any whole remaining-quota percentage from 0% to 100%
- **Pre-activation confirmation** — Display the current quota, stop threshold, and reasoning effort before requiring an explicit recommended-option approval
- **Reset detection** — Detect recovery from below 100% to 100% in the same quota window
- **Observation failure stop** — Stop after two consecutive checkpoints without a usable snapshot
- **Task-tree-wide state** — Share one stop state across the root, children, and grandchildren
- **Safe convergence** — Finish already-started work while blocking new hook-visible operations

## Quick Start

### Windows (PowerShell)

```powershell
git clone https://github.com/BrumeLight/codex-capacity-guard.git
cd codex-capacity-guard
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Locale auto
```

### macOS / Linux (Bash)

```bash
git clone https://github.com/BrumeLight/codex-capacity-guard.git
cd codex-capacity-guard
./install.sh --locale auto
```

Restart Codex, open a new task, and enter:

```text
Run this task with Capacity Guard until 30% quota remains.
```

Review the displayed current quota, stop threshold, and reasoning effort, then select the recommended option (`accept (Recommended)`, or its host-localized label) to enable the guard.

### Enable choice-based confirmation (experimental)

To show enable / deny choices in default mode, add the following to your personal `~/.codex/config.toml`:

```toml
[features]
default_mode_request_user_input = true
```

If `[features]` already exists, add only `default_mode_request_user_input = true` under the existing table instead of declaring it again. Restart Codex and open a new task after changing the setting.

This is an experimental feature. Its availability and behavior may change between Codex versions, and Codex may localize the option labels. When choice-based input is unavailable, Capacity Guard automatically falls back to a fixed-text confirmation that requires an exact `accept` reply.

## Usage

### Set a threshold

```text
Run this task with Capacity Guard until 30% quota remains.
```

You can specify any whole percentage from 0% to 100% in 1% increments.

### Use the default

```text
Run this task with Capacity Guard.
```

When no threshold is specified, the default is 0%.

### Confirm activation

```text
Current quota remaining: "82%".
Stop threshold: "30%".
Current reasoning effort: "high".
Enable Capacity Guard for this run?
```

- Recommended option (`accept (Recommended)`, or its host-localized label) — Enable the guard with the displayed values
- Deny option (`deny`, or its host-localized label) — Keep the guard OFF

## Installer Options

### PowerShell

| Option | Description | Default |
| --- | --- | --- |
| `-Locale auto\|ja\|en` | UI display-name language | `auto` |
| `-TargetRoot <path>` | Plugin destination root | `%USERPROFILE%\plugins` |

### Bash

| Option | Description | Default |
| --- | --- | --- |
| `--locale auto\|ja\|en` | UI display-name language | `auto` |
| `--target-root <path>` | Plugin destination root | `$HOME/plugins` |

`auto` uses the first Windows user language in PowerShell and the locale environment variables in Bash. Japanese displays “使いすぎ防止モード”; other languages display “Capacity Guard.”

## Output / Changes

The installer makes the following changes:

```text
%USERPROFILE%\plugins\capacity-guard\
└── plugin source

%USERPROFILE%\.agents\plugins\marketplace.json
└── personal marketplace entry
```

On macOS and Linux, the corresponding paths are `$HOME/plugins/capacity-guard/` and `$HOME/.agents/plugins/marketplace.json`.

- Moves an existing destination to `capacity-guard.backup.<UTC timestamp>` before copying
- Adds or updates `capacity-guard` in the personal marketplace
- Runs `codex plugin add capacity-guard@personal`
- Stores runtime state and payload-free invocation/failure audit events under the Codex-provided `PLUGIN_DATA` directory
- Fails closed for `PreToolUse` and activation requests on internal hook errors, and surfaces an unverifiable state for other events
- On first-turn activation, validates a plugin-observed quota snapshot no older than five minutes and rechecks it against the current task immediately before approval

## Requirements

- Windows PowerShell 5.1+, or Bash 3.2+ on macOS or Linux
- Node.js 18+
- A Codex CLI or Codex app version with plugin and Hooks support
- Git when installing by clone

Both PowerShell and Bash installers are included. Hook commands use the `${PLUGIN_ROOT}` placeholder expanded by Codex before execution instead of shell-specific environment-variable syntax.

## Project Structure

```text
.
├── .codex-plugin/plugin.json       # Plugin metadata
├── hooks/hooks.json                # Lifecycle hook definitions
├── scripts/
│   ├── capacity-guard-hook.mjs     # Decisions, shared state, and safe stopping
│   └── test-capacity-guard.mjs     # Synthetic tests
├── skills/capacity-guard/          # Codex usage instructions
├── install.ps1
├── install.sh
├── uninstall.ps1
├── uninstall.sh
├── CHANGELOG.md
├── README.md
├── README.en.md
└── LICENSE
```

## Development

The project uses no external npm packages.

```powershell
# Syntax check
node --check .\scripts\capacity-guard-hook.mjs
node --check .\scripts\test-capacity-guard.mjs

# Tests
node .\scripts\test-capacity-guard.mjs
```

## Safety / Notes

- Account-level quota may be shared, so consumption from other tasks can affect observations.
- Quota numbers alone cannot distinguish a discretionary user reset from a system reset.
- `resets_at` is recorded only as auxiliary evidence and never triggers a stop by itself.
- Hosted or specialized tools that do not emit `PreToolUse` are outside the enforcement guarantee.
- After TRIPPED, only `list_agents` and `wait_agent` are allowed for minimal convergence.
- The plugin does not automatically change the model, reasoning effort, or speed.
- The uninstallers remove the Codex installation cache entry while preserving the source and marketplace entry. Use `uninstall.ps1` in PowerShell or `uninstall.sh` in Bash.

## License

[MIT License](LICENSE) © 2026 BrumeLight
