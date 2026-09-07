---
name: capacity-guard
description: Run explicitly requested quota-limited work with prompt-first checks and a safe checkpoint before stopping. Use for Capacity Guard or 使いすぎ防止モード requests. Reviewing or editing this plugin does not activate it.
---

# Capacity Guard

## Agreement and scope

Enable only when the user explicitly asks to run work with this guard. Discussion, quoted examples, installation, review, or maintenance are not activation. Without that instruction, remain OFF and do not inspect quota, ask for guard approval, or interrupt ordinary work.

Use the user's remaining-quota threshold (0–100%). If it is missing or ambiguous, ask only for the missing threshold; do not invent 0%. An explicit instruction with a clear threshold is sufficient: no second approval, fixed wording, or exact `accept` token is required. Preserve the agreed threshold and scope across continuations until the user changes them or the guarded work ends.

Read the current account quota with the available usage-limits tool (in Codex Desktop: `mcp__codex_app__get_usage_limits`). Use `rateLimitsByLimitId` when present, and the legacy `rateLimits` otherwise. Remaining percent is `100 - usedPercent`, clamped to 0–100. Track the applicable quota bucket and its window separately; use the lowest applicable remaining percentage when several windows constrain the work. Do not mix unrelated model buckets. If the applicable bucket cannot be identified, clarify before new guarded work. Record observed values and time; missing values are unknown, never zero. A reported model or effort is not proof of the effective runtime setting.

Briefly state the agreed scope, threshold, and observed quota. Account usage includes concurrent tasks. This is best-effort prompt guidance, not an exact quota cap: reasoning, other tasks, and an already-running operation can cross the threshold between checks. If the starting quota is unavailable, do not claim active monitoring or start new guarded work; explain the missing observation. Finish any already-started work safely as below.

## Check at useful boundaries

Check before starting guarded work, before another substantial unit or delegation, and at meaningful completion/checkpoint boundaries. Increase care near the threshold; do not poll every tool or treat an unchanged fresh observation as a failure. Avoid launching an indivisible operation that is unlikely to fit the remaining margin. Do not spend quota to manufacture an exact threshold crossing.

Stop adding work when:

- Any applicable remaining quota reaches or falls below the agreed threshold.
- A new reliable reading for the same bucket/window shows a reset or unexpected recovery (for example, below 100% to 100%). Record the observation; numbers alone do not identify a user reset versus a scheduled reset. Do not automatically use the replenished quota.
- A required quota check fails or is unusable. One bounded read-only retry is reasonable for a transient failure, with no new task work between checks; if still unavailable, close safely with quota unknown. Do not count ordinary tool calls as failed observations.
- An internal monitoring error makes continued observation unreliable. Do not convert that error into blanket tool denial or claim protection is verified.

## Close safely, then stop

Once a stopping condition is observed, identify the operations already in progress and the smallest finite set of actions needed to leave recoverable state. Do not start another task, wave, feature, broad investigation, new agent, or discretionary cleanup. Finishing the entire original assignment is not required for safe stopping.

Let an indivisible operation finish, or use its supported safe cancellation when appropriate. Save in-progress edits coherently, collect the result of an already-started command, perform only validation needed to establish the state left behind, and write a checkpoint/handoff. These operations may use tools and writes. State why any nontrivial closing action is necessary; narrow or stop it if it starts growing into fresh work. Do not broaden authority for publishing, deleting, or other external effects.

For agents already working, tell them to stop taking new work, reach their next safe boundary, save their result/checkpoint, and return status. Wait for or collect those returns and verify the relevant saved artifacts. Do not spawn a replacement or take over their unfinished task. Do not force-kill an unknown side effect to satisfy the threshold. If a child or operation cannot be observed or safely stopped, record its identity and pending state, report that convergence is unverified, and leave explicit follow-up rather than claiming the tree stopped.

## Checkpoint and resume

Use the task's established writable record location. Save at task start, meaningful boundaries, before the final stop report, and before compaction when the runtime provides that opportunity. A pre-compaction notification is not guaranteed; boundary saves limit the loss. After compaction, read the checkpoint first, compare it with actual state, and update it before continuing.

Keep enough information to restore this task, without forcing unrelated fields:

- Purpose, accepted guard instruction/scope/threshold, latest quota with observation time, stop reason, and current status.
- Responsible actor and relevant parent/child task IDs; requested versus actually observed model/effort where relevant.
- Worktree, branch, HEAD, ownership and changes when working in a repository.
- Completion criteria, completed actions and evidence, unfinished or unverified items, risks and pending side effects.
- Handoff/artifact locations, required documents and applicable authority boundaries, outstanding owner decisions, and the next concrete action.

If saving fails, report the failure and provide the essential recovery information directly in the final response. Do not claim a checkpoint exists until its write is verified.

End with the stop reason, latest observed quota/time (or unknown), threshold, completed and pending work, checkpoint location, and concrete resume steps. Do not auto-resume on a later Goal continuation, recovered observation, or quota reset. Resume only when the user asks to continue, after re-reading the checkpoint and checking quota; preserve existing authorization and ask only about an actual ambiguity or changed boundary. If the same stop condition remains, report it without starting more work.

## Implementation boundary

The prompt controls this workflow. This version registers no hooks and does not use legacy hook state as activation authority. The old hook entrypoint is inert for installations transitioning from a previously loaded hook registration; it neither reads state nor denies tools. Existing historical state is left untouched. An already-running old hook process can still finish under its old code, so do not claim an instantaneous runtime switch.

Only add deterministic assistance after recording a concrete failure of these prompt instructions, its expected versus observed behavior, and why a targeted instruction cannot address it. Do not preemptively reintroduce an approval state machine, per-tool allowlist, or global tool blockade.
