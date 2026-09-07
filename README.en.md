# Capacity Guard

A Codex skill that stops adding work at the user's remaining-quota threshold, closes operations at a safe boundary, and saves a recovery checkpoint.

[日本語](README.md) · [MIT License](LICENSE)

## Use

```text
Use Capacity Guard for this task until remaining quota reaches 30%.
```

An explicit request with a clear threshold is sufficient. No duplicate approval or exact `accept` token is required. Ask only for a missing or ambiguous threshold. Discussion, examples, installation, and maintenance do not activate the guard. OFF does not observe quota or interfere with ordinary work.

Check the applicable quota bucket/windows with the available usage-limits tool at the start and meaningful work boundaries. Use the lowest applicable remaining percentage. Model and effort are unchanged.

## Safe stopping

At threshold, observed reset/unexpected recovery, or unusable required observation, stop adding work. A transient observation failure permits one bounded retry without intervening task work. Collect already-started results, cancel safely when appropriate, verify only what is necessary to establish recoverable state, and save a checkpoint/handoff. Do not start a new feature, next task, or replacement agent.

Tell running agents to close at a safe boundary, save, and return. Report unobserved operations honestly instead of claiming convergence. Report the reason, quota/time or unknown, threshold, completed/pending work, checkpoint, and next resume action. Reset and automatic Goal continuation do not authorize resumption. On user-directed resume, read the checkpoint and check quota again.

Save task-relevant actors, task, runtime settings, change ownership, evidence, unresolved work, authority boundaries, and next action at the start, useful boundaries, and before stopping. Save before compaction when possible; advance compaction notification and immediate pre-compaction saves are not guaranteed.

## Limits

Version 0.2.0 is prompt-first. It registers no hooks, state machine, or tool allowlist. Its legacy hook entrypoint reads/writes no state and returns an empty response. Historical hook files remain history, not activation authority.

Instruction adherence is best-effort, not a mechanical guarantee of an exact budget cap or whole-tree stopping. Other account tasks, reasoning between observations, and an already-running operation can consume quota. Add deterministic assistance only after a concrete prompt-control failure establishes its necessity.

## Install or update

Keep this repository in a durable location. Requires Node.js and Codex CLI with `plugin marketplace add` and `plugin add`.

```powershell
.\install.ps1 -Locale en
# Reuse an existing <parent>/capacity-guard source:
.\install.ps1 -Locale en -TargetRoot <parent>
```

```bash
./install.sh --locale en
./install.sh --locale en --target-root <parent>
```

The default destination is `~/plugins/capacity-guard`. When copying to a different existing destination, the installer preserves it in a timestamped backup. To register the source in place, specify its parent. The installer uses `<plugin>/.agents/plugins/marketplace.json` with source `./`, registers that directory as the personal marketplace, and adds/updates the plugin without removing the current installation first. If another personal marketplace is already registered, the CLI refuses the new source; inspect and integrate with that existing location before proceeding. The installer does not automatically remove existing registrations.

Running tasks are not stopped or restarted. Loaded instructions and old hook registrations are not guaranteed to refresh automatically. Use a new task after metadata reload; if required, finish current work safely before restarting the app yourself.

## Verification

```text
node --check scripts/capacity-guard-hook.mjs
node scripts/test-capacity-guard.mjs
```

The suite verifies absent hook registration and an inert legacy entrypoint across OFF, historical ARMED/TRIPPED, corrupt state, lock contention, audit write failure, and invalid input. It does not prove prompt adherence or actual Agent convergence.

See [SKILL.md](skills/capacity-guard/SKILL.md) for the operational instructions and [CHANGELOG.md](CHANGELOG.md) for history.
