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

When `request_user_input` is available, ask exactly one question:

- id: `capacity_guard_approval`
- question: `Current quota remaining: "<exact injected remaining>%". Stop threshold: "<exact requested threshold>%". Current reasoning effort: "<exact injected effort>". Enable 使いすぎ防止モード for this run?`
- options: `accept (Recommended)`, `deny`

Do not begin task work before the response. The hook verifies all three displayed values before `PostToolUse(request_user_input)` can arm the mode.

If `request_user_input` is unavailable, present this exact fallback block, substituting only the injected values:

```text
Current quota remaining: "<remaining>%".
Current reasoning effort: "<effort>".
Capacity Guard policy: stop_threshold=<threshold>%, reset=stop.
To enable Capacity Guard, reply with exactly `accept`; otherwise reply `deny`.
```

Only the next exact, case-sensitive prompt `accept` arms the fallback. Every other prompt keeps the guard OFF.

If the current quota value is unavailable, do not offer activation; report that the mode remains OFF because its starting value cannot be confirmed.

## Runtime behavior

- Treat the displayed reasoning effort as audit metadata, not an activation condition.
- Share one state across the root, children, and grandchildren through the parent `session_id`.
- Keep the guard ARMED across long-running and Goal continuations until the user sends exact `deny`, sends `disable capacity guard`, the session ends, or the guard trips.
- Stop when remaining quota reaches or falls below the accepted threshold.
- Warn that account-level quota may include consumption from other concurrent tasks.
- Warn users not to perform a discretionary quota reset during guarded work unless they intend to stop it; user and system reset causes are not distinguishable from quota numbers alone.

## Trip conditions

Trip before the next hook-visible tool when any enabled policy matches:

- `THRESHOLD_REACHED`: remaining quota reaches or falls below the accepted whole-percentage threshold.
- `RESET_DETECTED`: within the same `limit_id` and `window_minutes`, remaining quota changes from below 100% to 100%.
- `OBSERVATION_UNAVAILABLE`: two consecutive checkpoints have no usable quota snapshot.

Treat `resets_at` only as auxiliary evidence. Never infer whether a recovery was a user reset, system reset, billing refresh, quota refresh, or anomaly without separate evidence.

## Safe stop

After TRIPPED:

- allow an indivisible tool invocation that already passed `PreToolUse` to finish;
- allow only `list_agents` and `wait_agent` for minimal task-tree drain;
- block new tools, edits, MCP calls, spawns, follow-ups, waves, and next tasks;
- report current location, completed scope, trip reason, current quota, accepted threshold, and next task;
- end the assistant turn and leave continuation to the user.

Prefer hook-visible local tools during guarded work. Hosted and specialized tool paths that do not emit `PreToolUse` are outside the enforcement guarantee.
