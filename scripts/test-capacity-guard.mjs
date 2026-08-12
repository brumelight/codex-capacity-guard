#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "capacity-guard-test-"));
const hook = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(.:)/, "$1")), "capacity-guard-hook.mjs");
const pluginRoot = path.resolve(path.dirname(hook), "..");
let sequence = 0;

function validateHookCommands() {
  const config = JSON.parse(fs.readFileSync(path.join(pluginRoot, "hooks", "hooks.json"), "utf8"));
  const handlers = Object.values(config.hooks)
    .flatMap((groups) => groups)
    .flatMap((group) => group.hooks);

  assert.equal(handlers.length, 6);
  for (const handler of handlers) {
    assert.equal(handler.command, 'node "${PLUGIN_ROOT}/scripts/capacity-guard-hook.mjs"');
    assert.equal(handler.commandWindows, 'node "${PLUGIN_ROOT}\\scripts\\capacity-guard-hook.mjs"');
    assert.doesNotMatch(handler.commandWindows, /%PLUGIN_ROOT%|\$env:PLUGIN_ROOT/);
  }
}

function transcript(turnId, effort = "high", quota = undefined) {
  const records = [{
    timestamp: new Date().toISOString(),
    type: "turn_context",
    payload: { turn_id: turnId, effort, model: "gpt-test" },
  }];
  if (quota) {
    records.push({
      timestamp: new Date().toISOString(),
      type: "event_msg",
      payload: {
        type: "token_count",
        rate_limits: {
          limit_id: quota.limit_id ?? "codex",
          primary: {
            used_percent: 100 - quota.remaining,
            window_minutes: quota.window ?? 10080,
            resets_at: quota.resets_at ?? 1000,
          },
        },
      },
    });
  }
  const file = path.join(testRoot, `transcript-${sequence += 1}.jsonl`);
  fs.writeFileSync(file, `${records.map(JSON.stringify).join("\n")}\n`, "utf8");
  return file;
}

function run(input) {
  const result = spawnSync(process.execPath, [hook], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, CAPACITY_GUARD_DATA_DIR: testRoot },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

function denied(output) {
  return output?.hookSpecificOutput?.permissionDecision === "deny";
}

function approvalQuestion(current, threshold, effort) {
  return [{
    id: "capacity_guard_approval",
    question: `Current quota remaining: "${current}%". Stop threshold: "${threshold}%". Current reasoning effort: "${effort}". Enable 使いすぎ防止モード for this run?`,
  }];
}

function requestActivation(session, turn, effort, quota, prompt) {
  const file = transcript(turn, effort, quota);
  const output = run({
    hook_event_name: "UserPromptSubmit",
    session_id: session,
    turn_id: turn,
    transcript_path: file,
    model: "gpt-test",
    prompt,
  });
  return { file, output };
}

function approvalPre(session, turn, effort, file, current, threshold) {
  return run({
    hook_event_name: "PreToolUse",
    session_id: session,
    turn_id: turn,
    model: "gpt-test",
    transcript_path: file,
    tool_name: "request_user_input",
    tool_input: { questions: approvalQuestion(current, threshold, effort) },
  });
}

function approvalPost(session, turn, effort, file, current, threshold, approval = "accept (Recommended)") {
  return run({
    hook_event_name: "PostToolUse",
    session_id: session,
    turn_id: turn,
    transcript_path: file,
    tool_name: "request_user_input",
    tool_input: { questions: approvalQuestion(current, threshold, effort) },
    tool_response: { answers: { capacity_guard_approval: { answers: [approval] } } },
  });
}

function arm(session, turn, effort, quota, threshold = 0) {
  const { file, output } = requestActivation(
    session,
    turn,
    effort,
    quota,
    threshold === 0 ? "使いすぎ防止モードで実行して" : `残量${threshold}％まで使いすぎ防止モードで実行して`,
  );
  assert.match(output.hookSpecificOutput.additionalContext, new RegExp(`stop_threshold=${threshold}%`));
  assert.equal(denied(approvalPre(session, turn, effort, file, quota.remaining, threshold)), false);
  const armed = approvalPost(session, turn, effort, file, quota.remaining, threshold);
  assert.match(armed.hookSpecificOutput.additionalContext, /ARMED/);
  return file;
}

function pre(session, turn, file, tool = "Bash") {
  return run({ hook_event_name: "PreToolUse", session_id: session, turn_id: turn, transcript_path: file, model: "gpt-test", tool_name: tool });
}

try {
  validateHookCommands();

  const explicit = requestActivation("explicit", "e0", "high", { remaining: 73 }, "残量30％まで使いすぎ防止モードで実行して");
  assert.match(explicit.output.hookSpecificOutput.additionalContext, /remaining_percent="73"/);
  assert.match(explicit.output.hookSpecificOutput.additionalContext, /stop_threshold=30%/);

  const onePercent = requestActivation("one-percent", "o0", "medium", { remaining: 62 }, "残量37%までCapacity Guardで実行");
  assert.match(onePercent.output.hookSpecificOutput.additionalContext, /stop_threshold=37%/);

  const contextualPercent = requestActivation("contextual", "c0", "high", { remaining: 70 }, "現在70%なので、残量30%まで使いすぎ防止モードで実行して");
  assert.match(contextualPercent.output.hookSpecificOutput.additionalContext, /stop_threshold=30%/);

  const discussionOnly = requestActivation("discussion", "q0", "high", { remaining: 70 }, "使いすぎ防止モードって何？");
  assert.doesNotMatch(discussionOnly.output.hookSpecificOutput.additionalContext, /PENDING_APPROVAL/);

  const defaultThreshold = requestActivation("default", "d0", "low", { remaining: 55 }, "使いすぎ防止モードで実行して");
  assert.match(defaultThreshold.output.hookSpecificOutput.additionalContext, /stop_threshold=0%/);

  const decimal = requestActivation("decimal", "i0", "high", { remaining: 50 }, "残量12.5%まで使いすぎ防止モードで実行して");
  assert.match(decimal.output.hookSpecificOutput.additionalContext, /whole-number percentage/);

  const ambiguous = requestActivation("ambiguous", "a0", "high", { remaining: 50 }, "20%か30%まで使いすぎ防止モードで実行して");
  assert.match(ambiguous.output.hookSpecificOutput.additionalContext, /whole-number percentage/);

  const missing = requestActivation("missing", "m0", "high", undefined, "残量30%まで使いすぎ防止モードで実行して");
  assert.match(missing.output.hookSpecificOutput.additionalContext, /current quota value is unavailable/);

  const mismatch = requestActivation("mismatch", "mm0", "high", { remaining: 70 }, "残量30%まで使いすぎ防止モードで実行して");
  assert.equal(denied(approvalPre("mismatch", "mm0", "high", mismatch.file, 70, 31)), true);

  arm("threshold", "t0", "high", { remaining: 70 }, 30);
  assert.equal(denied(pre("threshold", "t1", transcript("t1", "medium", { remaining: 31 }))), false);
  const thresholdTrip = pre("threshold", "t2", transcript("t2", "low", { remaining: 30 }), "apply_patch");
  assert.match(thresholdTrip.hookSpecificOutput.permissionDecisionReason, /THRESHOLD_REACHED/);

  arm("reset", "r0", "ultra", { remaining: 34 }, 0);
  const resetTrip = pre("reset", "child", transcript("child", "high", { remaining: 100, resets_at: 3000 }), "collaboration.spawn_agent");
  assert.match(resetTrip.hookSpecificOutput.permissionDecisionReason, /RESET_DETECTED/);
  assert.equal(denied(pre("reset", "grandchild", transcript("grandchild", "high", { remaining: 100 }), "collaboration.followup_task")), true);
  assert.equal(denied(pre("reset", "grandchild", transcript("grandchild", "high", { remaining: 100 }), "collaboration.list_agents")), false);
  assert.equal(run({ hook_event_name: "Stop", session_id: "reset" }).continue, false);
  assert.equal(run({ hook_event_name: "SubagentStop", session_id: "reset" }).continue, false);

  arm("observation", "v0", "high", { remaining: 80 }, 0);
  assert.equal(denied(pre("observation", "v1", transcript("v1", "high"))), false);
  const observationTrip = pre("observation", "v2", transcript("v2", "high"), "apply_patch");
  assert.match(observationTrip.hookSpecificOutput.permissionDecisionReason, /OBSERVATION_UNAVAILABLE/);

  arm("persist", "p0", "high", { remaining: 80 }, 0);
  assert.deepEqual(run({ hook_event_name: "Stop", session_id: "persist" }), {});
  assert.equal(denied(pre("persist", "p1", transcript("p1", "medium", { remaining: 79 }))), false);
  run({ hook_event_name: "UserPromptSubmit", session_id: "persist", turn_id: "p2", transcript_path: transcript("p2", "medium", { remaining: 79 }), prompt: "deny" });
  assert.equal(denied(pre("persist", "p2", transcript("p2", "medium"))), false);

  const deny = requestActivation("denied", "n0", "high", { remaining: 80 }, "残量25%まで使いすぎ防止モードで実行して");
  approvalPre("denied", "n0", "high", deny.file, 80, 25);
  const denyResult = approvalPost("denied", "n0", "high", deny.file, 80, 25, "deny");
  assert.match(denyResult.hookSpecificOutput.additionalContext, /remains OFF/);

  const fallbackText = [
    "Current quota remaining: \"60%\".",
    "Current reasoning effort: \"medium\".",
    "Capacity Guard policy: stop_threshold=0%, reset=stop.",
    "To enable Capacity Guard, reply with exactly `accept`; otherwise reply `deny`.",
  ].join("\n");
  run({ hook_event_name: "Stop", session_id: "fallback", last_assistant_message: fallbackText });
  const fallbackArm = run({
    hook_event_name: "UserPromptSubmit",
    session_id: "fallback",
    turn_id: "f1",
    transcript_path: transcript("f1", "low", { remaining: 60 }),
    prompt: "accept",
  });
  assert.match(fallbackArm.hookSpecificOutput.additionalContext, /ARMED/);

  process.stdout.write("capacity-guard tests: PASS\n");
} finally {
  fs.rmSync(testRoot, { recursive: true, force: true });
}
