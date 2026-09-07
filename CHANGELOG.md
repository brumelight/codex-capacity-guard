# Changelog

All notable changes to Capacity Guard are documented in this file. This project follows [Semantic Versioning](https://semver.org/).

## [0.2.0] - Unreleased

### Changed

- Replace per-tool quota enforcement and exact-token approval with prompt-first operation based on the user's explicit scope and threshold.
- Stop adding work at threshold, reset/recovery, or unusable observation; permit finite safe close-out, child coordination, checkpoint writes, and truthful recovery instructions.
- Remove hook registrations and retain an inert legacy entrypoint. OFF performs no quota/state/audit work; legacy corrupt state, lock contention, or internal failures cannot cause a hook denial through this entrypoint.
- Treat historical hook state as history, not current activation authority. Prompt adherence and exact budget enforcement are not guaranteed.
- Register a self-contained local marketplace with relative source `./` before installation without first removing the installed plugin.
- Explicitly transfer the existing guard agreement at delegation, including history-free children; require child boundary observations or parent-assisted checks and propagate child-observed stops upstream.

### Validation

- Synthetic legacy-entrypoint and registration checks; representative prompt scenarios documented separately from actual Agent observations.
- Actual guarded-agent threshold convergence requires an authorized guarded run; the maintenance task does not enable the guard.

## [0.1.3] - 2026-08-23

### Fixed

- Select quota observations with one validated comparator: newest timestamp first and lower remaining quota on timestamp ties. Invalid, stale, expired, and future-dated candidates cannot poison later updates.
- Preserve the safest newer session observation when an older transcript is replayed, and count repeated snapshots as missing checkpoints instead of indefinitely refreshing protection.
- Check TRIPPED/ARMED/OFF state before reading the shared snapshot so a corrupt snapshot cannot block an OFF session.
- Restrict snapshot fallback to the same parent session, preventing unrelated sessions from authorizing bootstrap or runtime work.
- Replace pathname file locks with atomic lock directories and owner-token-specific markers. Release and reclaim remove only the inspected token marker and use non-recursive `rmdir`, so stale owners and concurrent reapers cannot delete a successor lock.
- Reject every future-dated observation, including values inside ordinary clock-skew tolerances, so a future high-quota value cannot outrank a current low-quota observation.
- Bind approval to `tool_use_id`, turn, the exact one-question/two-option canonical form, displayed quota, and observation identity; bind fallback acceptance to the exact four-line message fingerprint and unchanged displayed observation.
- Revalidate the atomic lock directory identity, sole owner marker, and marker contents immediately before each protected update, closing the empty-directory reclaim/publish gap without recursive deletion.
- Validate directory identity before marker publication and twice during release, so an unpublished or empty successor directory cannot be modified or removed by an older generation; failed publication cleans only its own marker.
- Collapse PreToolUse state gating and mutation into one state-lock critical section and share a 2.5-second hook-wide lock-wait deadline, preserving response margin inside the five-second hook timeout.
- Require the fallback acceptance raw prompt to equal `accept` without trimming, and normalize only CRLF sequences in the canonical four-line block.
- Derive lock inspection identity and mtime from one bigint filesystem stat, preventing a delete/recreate between separate stat calls from mixing generations.
- Measure the shared hook lock-wait deadline with a monotonic clock so wall-clock rollback cannot extend the timeout budget.
- Bound live/PID-reuse lock stalls with a ten-minute hard maximum while retaining PID/permission protection during the normal stale interval.
- Ignore Capacity Guard mentions inside code fences, inline code, blockquotes, and quoted text without treating apostrophes in contractions as quote delimiters.
- Replace raw audit tool names and blocked-tool names with coarse tool classes.

### Added

- Version 2 state and quota-snapshot schemas with safe migration of legacy OFF/ARMED/TRIPPED state, reapproval for legacy pending state, and in-place snapshot upgrade.
- Deterministic regression coverage for timestamp ordering, conservative ties, +1/+15/+29-second future poisoning, cross-session isolation, repeated observations, rollback prevention, canonical approval/fallback identity, OFF corrupt-cache behavior, two-reaper and publish-gap lock ownership, injected process liveness/PID reuse, mention quoting, audit minimization, first-prompt behavior, and legacy migration.
- Shuffled 20-process snapshot concurrency coverage matching Codex's concurrent command-hook execution model.

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
