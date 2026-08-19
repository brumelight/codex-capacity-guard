# Changelog

All notable changes to Capacity Guard are documented in this file. This project follows [Semantic Versioning](https://semver.org/).

## [0.1.2] - 2026-08-20

### Fixed

- Serialize global quota-snapshot updates across hook processes, keep the newest observation, and clean up failed atomic-write temp files.
- Reuse a fresh validated quota snapshot during ARMED runtime checkpoints instead of incorrectly counting the observation as missing.
- Recognize localized Desktop mention labels and the canonical plugin URI with or without its trailing slash.

### Added

- Concurrent 20-process quota-snapshot regression coverage, including newest-observation ordering and temp-file cleanup.
- Runtime bootstrap, expired-snapshot, localized mention, and negative plugin-destination regression coverage.
- Payload-free tool/transcript presence and filesystem failure metadata in hook audit events.

## [0.1.1] - 2026-08-13

First formal GitHub release. This release supersedes the locally distributed `0.1.0+codex.20260809230926` build.

### Added

- Whole-percentage remaining-quota thresholds from 0% through 100%.
- Explicit activation approval showing the verified quota, threshold, and reasoning effort.
- Shared parent/child agent state, reset detection, observation-failure stopping, and safe task-tree convergence.
- PowerShell and Bash installers with Japanese and English display names.
- Payload-free hook invocation and failure audit events.

### Fixed

- Use Codex's `${PLUGIN_ROOT}` placeholder on Windows instead of shell-specific environment expansion.
- Fail closed when hook execution or state verification fails.
- Recognize `$capacity-guard`, `@capacity-guard`, and canonical Desktop plugin mentions.
- Bootstrap first-turn approval from a fresh, validated quota snapshot and revalidate it before arming.
- Parse the host's serialized approval response shape.
- Accept the exact recommended option from the approval question when Codex localizes its label, while rejecting deny and unlisted recommended-looking values.

### Verified

- Full synthetic hook suite passes on Node.js.
- Desktop canonical-plugin-mention activation reaches and maintains `ARMED` after localized approval.
- An active long-running task remained `ARMED` across subsequent hook checkpoints.
