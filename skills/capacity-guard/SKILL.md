---
name: capacity-guard
description: Protect long-running Codex work with an explicitly accepted quota-remaining threshold, reset detector, and observation-failure stop. Use when the user asks for Capacity Guard, 使いすぎ防止モード, quota protection, a remaining-percentage limit, safe long-task execution, or wants to prevent a Goal, multi-agent task, or extended workflow from consuming too much capacity. This guard is model- and reasoning-effort-independent.
---

# Capacity Guard

## Activation

Accept a natural-language threshold such as `残量30％まで使いすぎ防止モードで実行して`.

- Interpret the single percentage as the remaining-quota stop threshold.
- Accept only a whole number from 0% through 100%, so every 1% step is configurable.
- Use 0% when the user provides no percentage.
- Reject decimal, out-of-range, or multiple percentages as ambiguous.

Read the `CAPACITY_GUARD_RUNTIME`, `CAPACITY_GUARD_QUOTA`, and `PENDING_APPROVAL; stop_threshold=N%` metadata injected by `UserPromptSubmit`. Never arm without explicit `accept`.

Treat plugin mentions inside code fences, inline code, blockquotes, or quoted text as discussion/examples, not activation requests. Canonical Desktop mentions may use a localized label and may include the trailing slash in `plugin://capacity-guard@personal/`.

When `request_user_input` is available, ask exactly one question:

- id: `capacity_guard_approval`
- question: `Current quota remaining: "<exact injected remaining>%". Stop threshold: "<exact requested threshold>%". Current reasoning effort: "<exact injected effort>". Enable 使いすぎ防止モード for this run?`
- first option: label `accept (Recommended)`; description `Enable Capacity Guard for this run.`
- second option: label `deny`; description `Keep Capacity Guard off.`

Do not add a prefix, suffix, second question, third option, or localized alternative. Do not begin task work before the response. Only the exact canonical answer `accept (Recommended)` arms; `deny` keeps the guard OFF, and an answer not present in the canonical options cannot arm.

The hook binds the approval to its `tool_use_id`, turn, canonical question shape, displayed quota, and observation identity in both PreToolUse and PostToolUse. It permits only CRLF/LF newline normalization. If any identity or canonical field is missing or changed, do not claim the mode is armed; request a fresh approval.

If `request_user_input` is unavailable, present this exact fallback block, substituting only the injected values:

```text
Current quota remaining: "<remaining>%".
Current reasoning effort: "<effort>".
Capacity Guard policy: stop_threshold=<threshold>%, reset=stop.
To enable Capacity Guard, reply with exactly `accept`; otherwise reply `deny`.
```

The assistant message must be exactly this four-line block, with no surrounding text or unrelated permission request. Only CRLF sequences are normalized to LF; bare CR is rejected. Only a next raw prompt exactly equal to the case-sensitive string `accept` arms the fallback. Surrounding spaces, tabs, and newlines are not trimmed and cannot arm. Every other prompt keeps the guard OFF. The hook revalidates the saved block fingerprint at acceptance.

Fallback acceptance is valid only while the displayed quota observation identity is unchanged. If quota drifts, resets, or is newly observed before `accept`, keep the guard OFF and request activation again with the new values.

If the current quota value is unavailable, do not offer activation; report that the mode remains OFF because its starting value cannot be confirmed. This can occur on the first prompt of a new task before the same `session_id` has a stable quota observation. Retry later in that same task after a hook-visible checkpoint; never hand-write a snapshot or borrow another task's value.

## Runtime behavior

- Treat the displayed reasoning effort as audit metadata, not an activation condition.
- Share one state across the root, children, and grandchildren through the parent `session_id`.
- Use quota-snapshot fallback only when it was observed in that same parent `session_id`; never use another session's snapshot to authorize work.
- Treat an observation as new only when its validated timestamp is newer, or when the timestamp ties and its remaining quota is lower. Re-reading an identical or older snapshot is a missing checkpoint.
- Keep the guard ARMED across long-running and Goal continuations until the user sends exact `deny`, sends `disable capacity guard`, the session ends, or the guard trips.
- Stop when remaining quota reaches or falls below the accepted threshold.
- Warn that account-level quota may include consumption from other concurrent tasks.
- Warn users not to perform a discretionary quota reset during guarded work unless they intend to stop it; user and system reset causes are not distinguishable from quota numbers alone.

## Trip conditions

Trip before the next hook-visible tool when any enabled policy matches:

- `THRESHOLD_REACHED`: remaining quota reaches or falls below the accepted whole-percentage threshold.
- `RESET_DETECTED`: within the same `limit_id` and `window_minutes`, remaining quota changes from below 100% to 100%.
- `OBSERVATION_UNAVAILABLE`: two consecutive checkpoints have no new usable quota observation.

Invalid, stale, expired, and future-dated observations are unavailable. Treat any timestamp later than the hook's current time as future-dated, without a positive clock-skew allowance. Legacy pending approvals require a fresh approval after migration; never infer acceptance from old state.

Treat `resets_at` only as auxiliary evidence. Never infer whether a recovery was a user reset, system reset, billing refresh, quota refresh, or anomaly without separate evidence.

## Safe stop

After TRIPPED:

- allow an indivisible tool invocation that already passed `PreToolUse` to finish;
- allow only `list_agents` and `wait_agent` for minimal task-tree drain;
- block new tools, edits, MCP calls, spawns, follow-ups, waves, and next tasks;
- report current location, completed scope, trip reason, current quota, accepted threshold, and next task;
- end the assistant turn and leave continuation to the user.

Prefer hook-visible local tools during guarded work. Hosted and specialized tool paths that do not emit `PreToolUse` are outside the enforcement guarantee.
