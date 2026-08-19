#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

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
  const observedAt = quota?.observed_at ?? new Date().toISOString();
  const records = [{
    timestamp: new Date().toISOString(),
    type: "turn_context",
    payload: { turn_id: turnId, effort, model: "gpt-test" },
  }];
  if (quota) {
    records.push({
      timestamp: observedAt,
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

function writeQuotaSnapshot(quota, capturedAt = new Date()) {
  fs.writeFileSync(path.join(testRoot, "quota-latest.json"), `${JSON.stringify({
    schema_version: 1,
    captured_at: capturedAt.toISOString(),
    source_session_id: "previous-session",
    quota: {
      remaining_percent: quota.remaining,
      used_percent: 100 - quota.remaining,
      window_minutes: quota.window ?? 10080,
      resets_at: quota.resets_at,
      limit_id: quota.limit_id ?? "codex",
      observed_at: capturedAt.toISOString(),
    },
  }, null, 2)}\n`, "utf8");
}

function runRaw(raw, env = {}) {
  const result = spawnSync(process.execPath, [hook], {
    input: raw,
    encoding: "utf8",
    env: { ...process.env, CAPACITY_GUARD_DATA_DIR: testRoot, ...env },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

function run(input, env = {}) {
  return runRaw(JSON.stringify(input), env);
}

function runRawAsync(raw, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hook], {
      encoding: "utf8",
      env: { ...process.env, CAPACITY_GUARD_DATA_DIR: testRoot, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => {
      if (status !== 0) return reject(new Error(stderr || `hook exited ${status}`));
      try { return resolve(JSON.parse(stdout.trim())); } catch (error) { return reject(error); }
    });
    child.stdin.end(raw);
  });
}

function runAsync(input, env = {}) {
  return runRawAsync(JSON.stringify(input), env);
}

function denied(output) {
  return output?.hookSpecificOutput?.permissionDecision === "deny";
}

function approvalQuestion(current, threshold, effort, optionLabels = ["accept (Recommended)", "deny"]) {
  return [{
    id: "capacity_guard_approval",
    question: `Current quota remaining: "${current}%". Stop threshold: "${threshold}%". Current reasoning effort: "${effort}". Enable 使いすぎ防止モード for this run?`,
    options: optionLabels.map((label) => ({ label, description: label })),
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

function approvalPost(session, turn, effort, file, current, threshold, approval = "accept (Recommended)", modelFacingString = false, optionLabels) {
  const response = { answers: { capacity_guard_approval: { answers: [approval] } } };
  return run({
    hook_event_name: "PostToolUse",
    session_id: session,
    turn_id: turn,
    transcript_path: file,
    tool_name: "request_user_input",
    tool_input: { questions: approvalQuestion(current, threshold, effort, optionLabels) },
    tool_response: modelFacingString ? JSON.stringify(response) : response,
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

  const concurrentBase = Date.now() - 1000;
  const concurrentRuns = Array.from({ length: 20 }, (_, index) => {
    const turn = `concurrent-turn-${index}`;
    const file = transcript(turn, "high", {
      remaining: 80 - index,
      resets_at: Math.floor(Date.now() / 1000) + 3600,
      observed_at: new Date(concurrentBase + (index * 10)).toISOString(),
    });
    return runAsync({
      hook_event_name: "PreToolUse",
      session_id: `concurrent-session-${index}`,
      turn_id: turn,
      transcript_path: file,
      model: "gpt-test",
      tool_name: "Bash",
    });
  });
  const concurrentOutputs = await Promise.all(concurrentRuns);
  assert.ok(concurrentOutputs.every((output) => !denied(output)));
  const concurrentSnapshot = JSON.parse(fs.readFileSync(path.join(testRoot, "quota-latest.json"), "utf8"));
  assert.equal(concurrentSnapshot.quota.remaining_percent, 61);
  assert.deepEqual(fs.readdirSync(testRoot).filter((name) => /^quota-latest\.json\..+\.tmp$/.test(name)), []);

  const explicit = requestActivation("explicit", "e0", "high", { remaining: 73 }, "残量30％まで使いすぎ防止モードで実行して");
  assert.match(explicit.output.hookSpecificOutput.additionalContext, /remaining_percent="73"/);
  assert.match(explicit.output.hookSpecificOutput.additionalContext, /stop_threshold=30%/);

  const dollarMention = requestActivation("dollar-mention", "dm0", "high", { remaining: 73 }, "$capacity-guard hook不具合検証");
  assert.match(dollarMention.output.hookSpecificOutput.additionalContext, /PENDING_APPROVAL; stop_threshold=0%/);

  const atMention = requestActivation("at-mention", "am0", "high", { remaining: 73 }, "@capacity-guard hook不具合検証");
  assert.match(atMention.output.hookSpecificOutput.additionalContext, /PENDING_APPROVAL; stop_threshold=0%/);

  const desktopMention = requestActivation("desktop-mention", "pm0", "high", { remaining: 73 }, "[@capacity-guard](plugin://capacity-guard@personal) hook不具合検証");
  assert.match(desktopMention.output.hookSpecificOutput.additionalContext, /PENDING_APPROVAL; stop_threshold=0%/);

  const localizedDesktopMention = requestActivation("localized-desktop-mention", "lpm0", "high", { remaining: 73 }, "[@使いすぎ防止モード](plugin://capacity-guard@personal/) 5%");
  assert.match(localizedDesktopMention.output.hookSpecificOutput.additionalContext, /PENDING_APPROVAL; stop_threshold=5%/);

  const slashDesktopMention = requestActivation("slash-desktop-mention", "spm0", "high", { remaining: 73 }, "[@capacity-guard](plugin://capacity-guard@personal/) 5%");
  assert.match(slashDesktopMention.output.hookSpecificOutput.additionalContext, /PENDING_APPROVAL; stop_threshold=5%/);

  const localizedNoSlashMention = requestActivation("localized-no-slash", "lns0", "high", { remaining: 73 }, "[@使いすぎ防止モード](plugin://capacity-guard@personal) 5%");
  assert.match(localizedNoSlashMention.output.hookSpecificOutput.additionalContext, /PENDING_APPROVAL; stop_threshold=5%/);

  const rawPluginUri = requestActivation("raw-plugin-uri", "pu0", "high", { remaining: 73 }, "plugin://capacity-guard@personal というURIは何？");
  assert.doesNotMatch(rawPluginUri.output.hookSpecificOutput.additionalContext, /PENDING_APPROVAL/);

  const rawPluginUriSlash = requestActivation("raw-plugin-uri-slash", "pus0", "high", { remaining: 73 }, "plugin://capacity-guard@personal/ というURIは何？");
  assert.doesNotMatch(rawPluginUriSlash.output.hookSpecificOutput.additionalContext, /PENDING_APPROVAL/);

  const wrongPluginMention = requestActivation("wrong-plugin-mention", "wpm0", "high", { remaining: 73 }, "[@使いすぎ防止モード](plugin://other@personal/) 5%");
  assert.doesNotMatch(wrongPluginMention.output.hookSpecificOutput.additionalContext, /PENDING_APPROVAL/);

  const wrongMarketplaceMention = requestActivation("wrong-marketplace-mention", "wmm0", "high", { remaining: 73 }, "[@使いすぎ防止モード](plugin://capacity-guard@other/) 5%");
  assert.doesNotMatch(wrongMarketplaceMention.output.hookSpecificOutput.additionalContext, /PENDING_APPROVAL/);

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

  const futureReset = Math.floor(Date.now() / 1000) + 3600;
  writeQuotaSnapshot({ remaining: 64, resets_at: futureReset });
  const bootstrap = requestActivation("bootstrap", "b0", "high", undefined, "[@capacity-guard](plugin://capacity-guard@personal)");
  assert.match(bootstrap.output.hookSpecificOutput.additionalContext, /remaining_percent="64"/);
  assert.match(bootstrap.output.hookSpecificOutput.additionalContext, /PENDING_APPROVAL; stop_threshold=0%/);
  const bootstrapApprovalFile = transcript("b0", "high");
  assert.equal(denied(approvalPre("bootstrap", "b0", "high", bootstrapApprovalFile, 64, 0)), false);
  assert.match(approvalPost("bootstrap", "b0", "high", bootstrapApprovalFile, 64, 0, "accept (Recommended)", true).hookSpecificOutput.additionalContext, /ARMED/);
  assert.equal(denied(pre("bootstrap", "b1", transcript("b1", "high"), "codex_appcreate_thread")), false);
  assert.equal(denied(pre("bootstrap", "b2", transcript("b2", "high"), "Bash")), false);

  const localized = requestActivation("localized-approval", "la0", "high", { remaining: 53 }, "[@capacity-guard](plugin://capacity-guard@personal) 動作確認");
  assert.equal(denied(approvalPre("localized-approval", "la0", "high", localized.file, 53, 0)), false);
  const localizedLabels = ["有効化 (Recommended)", "拒否"];
  const localizedResult = approvalPost("localized-approval", "la0", "high", localized.file, 53, 0, "有効化 (Recommended)", true, localizedLabels);
  assert.match(localizedResult.hookSpecificOutput.additionalContext, /ARMED/);

  const localizedDeny = requestActivation("localized-deny", "ld0", "high", { remaining: 53 }, "$capacity-guard");
  approvalPre("localized-deny", "ld0", "high", localizedDeny.file, 53, 0);
  const localizedDenyResult = approvalPost("localized-deny", "ld0", "high", localizedDeny.file, 53, 0, "拒否", true, localizedLabels);
  assert.match(localizedDenyResult.hookSpecificOutput.additionalContext, /remains OFF/);

  const unlistedRecommended = requestActivation("unlisted-recommended", "ur0", "high", { remaining: 53 }, "$capacity-guard");
  approvalPre("unlisted-recommended", "ur0", "high", unlistedRecommended.file, 53, 0);
  const unlistedResult = approvalPost("unlisted-recommended", "ur0", "high", unlistedRecommended.file, 53, 0, "危険 (Recommended)", true, localizedLabels);
  assert.match(unlistedResult.hookSpecificOutput.additionalContext, /remains OFF/);

  writeQuotaSnapshot({ remaining: 64, resets_at: futureReset });
  const expiresBeforeApproval = requestActivation("expires-before-approval", "eba0", "high", undefined, "$capacity-guard");
  assert.match(expiresBeforeApproval.output.hookSpecificOutput.additionalContext, /PENDING_APPROVAL/);
  writeQuotaSnapshot({ remaining: 64, resets_at: futureReset }, new Date(Date.now() - (6 * 60_000)));
  assert.equal(denied(approvalPre("expires-before-approval", "eba0", "high", transcript("eba0", "high"), 64, 0)), true);

  writeQuotaSnapshot({ remaining: 64, resets_at: futureReset }, new Date(Date.now() - (6 * 60_000)));
  const staleBootstrap = requestActivation("stale-bootstrap", "sb0", "high", undefined, "$capacity-guard");
  assert.match(staleBootstrap.output.hookSpecificOutput.additionalContext, /current quota value is unavailable/);

  writeQuotaSnapshot({ remaining: 64, resets_at: futureReset });
  const forgedFresh = JSON.parse(fs.readFileSync(path.join(testRoot, "quota-latest.json"), "utf8"));
  forgedFresh.quota.observed_at = new Date(Date.now() - (6 * 60_000)).toISOString();
  fs.writeFileSync(path.join(testRoot, "quota-latest.json"), `${JSON.stringify(forgedFresh, null, 2)}\n`, "utf8");
  const staleObservation = requestActivation("stale-observation", "so0", "high", undefined, "$capacity-guard");
  assert.match(staleObservation.output.hookSpecificOutput.additionalContext, /current quota value is unavailable/);

  writeQuotaSnapshot({ remaining: 64, resets_at: futureReset, limit_id: "other" });
  const wrongLimit = requestActivation("wrong-limit", "wl0", "high", undefined, "$capacity-guard");
  assert.match(wrongLimit.output.hookSpecificOutput.additionalContext, /current quota value is unavailable/);

  writeQuotaSnapshot({ remaining: 64, resets_at: futureReset, window: 0 });
  const wrongWindow = requestActivation("wrong-window", "ww0", "high", undefined, "$capacity-guard");
  assert.match(wrongWindow.output.hookSpecificOutput.additionalContext, /current quota value is unavailable/);

  writeQuotaSnapshot({ remaining: 64, resets_at: Math.floor(Date.now() / 1000) - 1 });
  const expiredReset = requestActivation("expired-reset", "er0", "high", undefined, "$capacity-guard");
  assert.match(expiredReset.output.hookSpecificOutput.additionalContext, /current quota value is unavailable/);

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
  fs.rmSync(path.join(testRoot, "quota-latest.json"), { force: true });
  assert.equal(denied(pre("observation", "v1", transcript("v1", "high"))), false);
  const observationTrip = pre("observation", "v2", transcript("v2", "high"), "apply_patch");
  assert.match(observationTrip.hookSpecificOutput.permissionDecisionReason, /OBSERVATION_UNAVAILABLE/);

  arm("expired-runtime", "x0", "high", { remaining: 80 }, 0);
  writeQuotaSnapshot({ remaining: 80, resets_at: futureReset }, new Date(Date.now() - (6 * 60_000)));
  assert.equal(denied(pre("expired-runtime", "x1", transcript("x1", "high"))), false);
  const expiredRuntimeTrip = pre("expired-runtime", "x2", transcript("x2", "high"), "codex_appcreate_thread");
  assert.match(expiredRuntimeTrip.hookSpecificOutput.permissionDecisionReason, /OBSERVATION_UNAVAILABLE/);

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

  const malformedActivation = runRaw('{"hook_event_name":"UserPromptSubmit","session_id":"malformed","prompt":"$capacity-guard",}');
  assert.equal(malformedActivation.continue, false);
  assert.match(malformedActivation.systemMessage, /not enabled/);

  const invalidDataDir = path.join(testRoot, "not-a-directory");
  fs.writeFileSync(invalidDataDir, "fixture", "utf8");
  const ioFailure = run({
    hook_event_name: "UserPromptSubmit",
    session_id: "io-failure",
    turn_id: "io0",
    transcript_path: transcript("io0", "high", { remaining: 70 }),
    prompt: "$capacity-guard",
  }, { CAPACITY_GUARD_DATA_DIR: invalidDataDir });
  assert.equal(ioFailure.continue, false);
  assert.match(ioFailure.systemMessage, /not enabled/);

  const lockedSession = "fresh-lock";
  fs.writeFileSync(path.join(testRoot, `${lockedSession}.json.lock`), "fixture", "utf8");
  const lockFailure = pre(lockedSession, "lock0", transcript("lock0", "high", { remaining: 70 }));
  assert.equal(denied(lockFailure), true);
  assert.match(lockFailure.hookSpecificOutput.permissionDecisionReason, /failed internally/);

  const staleSession = "stale-lock";
  const stalePath = path.join(testRoot, `${staleSession}.json.lock`);
  fs.writeFileSync(stalePath, "fixture", "utf8");
  const staleTime = new Date(Date.now() - 60_000);
  fs.utimesSync(stalePath, staleTime, staleTime);
  const staleRecovery = requestActivation(staleSession, "stale0", "high", { remaining: 70 }, "$capacity-guard");
  assert.match(staleRecovery.output.hookSpecificOutput.additionalContext, /PENDING_APPROVAL/);
  assert.equal(fs.existsSync(stalePath), false);

  const auditEvents = fs.readFileSync(path.join(testRoot, "events.jsonl"), "utf8")
    .trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.ok(auditEvents.some((event) => event.event === "invoked" && event.hook_event_name === "UserPromptSubmit"));
  assert.ok(auditEvents.some((event) => event.event === "failed" && event.session_id === "malformed"));
  assert.equal(auditEvents.some((event) => event.event === "failed" && String(event.session_id).startsWith("concurrent-session-")), false);

  process.stdout.write("capacity-guard tests: PASS\n");
} finally {
  fs.rmSync(testRoot, { recursive: true, force: true });
}
