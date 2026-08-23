#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "capacity-guard-test-"));
const hook = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(.:)/, "$1")), "capacity-guard-hook.mjs");
const pluginRoot = path.resolve(path.dirname(hook), "..");
const {
  inspectDirectoryLock,
  monotonicDeadline,
  monotonicDeadlineReached,
  publishDirectoryLock,
  processIsAlive,
  readDirectoryIdentity,
  reclaimInspectedDirectoryLock,
  reclaimStaleDirectoryLock,
  releaseDirectoryLock,
  verifyPublishedDirectoryLock,
} = await import(pathToFileURL(hook).href);
let sequence = 0;

function validateHookCommands() {
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"));
  assert.equal(manifest.version, "0.1.3");
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
  assert.equal(config.hooks.PreToolUse[0].hooks[0].timeout, 5);
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
            resets_at: quota.resets_at ?? Math.floor(Date.now() / 1000) + 3600,
          },
        },
      },
    });
  }
  const file = path.join(testRoot, `transcript-${sequence += 1}.jsonl`);
  fs.writeFileSync(file, `${records.map(JSON.stringify).join("\n")}\n`, "utf8");
  return file;
}

function writeQuotaSnapshot(quota, capturedAt = new Date(), sourceSessionId = "previous-session", schemaVersion = 2) {
  const observedAt = quota.observed_at ? new Date(quota.observed_at) : capturedAt;
  fs.writeFileSync(path.join(testRoot, "quota-latest.json"), `${JSON.stringify({
    schema_version: schemaVersion,
    captured_at: capturedAt.toISOString(),
    source_session_id: sourceSessionId,
    quota: {
      remaining_percent: quota.remaining,
      used_percent: 100 - quota.remaining,
      window_minutes: quota.window ?? 10080,
      resets_at: quota.resets_at,
      limit_id: quota.limit_id ?? "codex",
      observed_at: observedAt.toISOString(),
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

function readState(session) {
  return JSON.parse(fs.readFileSync(path.join(testRoot, `${session}.json`), "utf8"));
}

function writeState(session, state) {
  fs.writeFileSync(path.join(testRoot, `${session}.json`), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function createDirectoryLock(lockDir, owner, rawContent = null) {
  fs.mkdirSync(lockDir);
  const markerPath = path.join(lockDir, `owner.${owner.owner_token}.json`);
  fs.writeFileSync(markerPath, rawContent ?? `${JSON.stringify(owner)}\n`, "utf8");
  return markerPath;
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
  const canonicalDescriptions = {
    "accept (Recommended)": "Enable Capacity Guard for this run.",
    deny: "Keep Capacity Guard off.",
  };
  return [{
    id: "capacity_guard_approval",
    question: `Current quota remaining: "${current}%". Stop threshold: "${threshold}%". Current reasoning effort: "${effort}". Enable 使いすぎ防止モード for this run?`,
    options: optionLabels.map((label) => ({ label, description: canonicalDescriptions[label] ?? label })),
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

function approvalPre(session, turn, effort, file, current, threshold, optionLabels, toolUseId = `approval-${session}-${turn}`) {
  return run({
    hook_event_name: "PreToolUse",
    session_id: session,
    turn_id: turn,
    model: "gpt-test",
    transcript_path: file,
    tool_use_id: toolUseId,
    tool_name: "request_user_input",
    tool_input: { questions: approvalQuestion(current, threshold, effort, optionLabels) },
  });
}

function approvalPost(session, turn, effort, file, current, threshold, approval = "accept (Recommended)", modelFacingString = false, optionLabels, toolUseId = `approval-${session}-${turn}`) {
  const response = { answers: { capacity_guard_approval: { answers: [approval] } } };
  return run({
    hook_event_name: "PostToolUse",
    session_id: session,
    turn_id: turn,
    transcript_path: file,
    tool_use_id: toolUseId,
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

  const originalDateNow = Date.now;
  let wallNow = 50_000;
  let monotonicNow = 10_000;
  Date.now = () => wallNow;
  try {
    const rollbackSafeDeadline = monotonicDeadline(2_500, () => monotonicNow);
    assert.equal(rollbackSafeDeadline - monotonicNow, 2_500);
    wallNow -= 40_000;
    monotonicNow += 2_499;
    assert.equal(monotonicDeadlineReached(rollbackSafeDeadline, () => monotonicNow), false);
    wallNow -= 5_000;
    monotonicNow += 1;
    assert.equal(monotonicDeadlineReached(rollbackSafeDeadline, () => monotonicNow), true);
  } finally {
    Date.now = originalDateNow;
  }

  const concurrentBase = Date.now() - 1000;
  const concurrentOrder = [19, 2, 17, 4, 15, 6, 13, 8, 11, 10, 9, 12, 7, 14, 5, 16, 3, 18, 1, 0];
  const concurrentRuns = concurrentOrder.map((index) => {
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

  const deterministicBase = Date.now() - 2_000;
  fs.rmSync(path.join(testRoot, "quota-latest.json"), { force: true });
  pre("ordering-new", "on", transcript("on", "high", { remaining: 20, observed_at: new Date(deterministicBase + 1_000).toISOString() }));
  pre("ordering-old", "oo", transcript("oo", "high", { remaining: 80, observed_at: new Date(deterministicBase).toISOString() }));
  assert.equal(JSON.parse(fs.readFileSync(path.join(testRoot, "quota-latest.json"), "utf8")).quota.remaining_percent, 20);

  const equalObservedAt = new Date(deterministicBase + 1_500).toISOString();
  for (const order of [[20, 80], [80, 20]]) {
    fs.rmSync(path.join(testRoot, "quota-latest.json"), { force: true });
    for (const remaining of order) {
      pre(`equal-${order.join("-")}-${remaining}`, `eq-${remaining}`, transcript(`eq-${remaining}`, "high", { remaining, observed_at: equalObservedAt }));
    }
    assert.equal(JSON.parse(fs.readFileSync(path.join(testRoot, "quota-latest.json"), "utf8")).quota.remaining_percent, 20);
  }

  writeQuotaSnapshot({ remaining: 64, resets_at: Math.floor(Date.now() / 1000) + 3600, observed_at: new Date(Date.now() + 60_000).toISOString() }, new Date(Date.now() + 60_000), "future-poison");
  pre("future-poison", "fp0", transcript("fp0", "high", { remaining: 50 }));
  const futureRecovered = JSON.parse(fs.readFileSync(path.join(testRoot, "quota-latest.json"), "utf8"));
  assert.equal(futureRecovered.quota.remaining_percent, 50);
  assert.ok(Date.parse(futureRecovered.quota.observed_at) <= Date.now() + 5_000);

  for (const futureSeconds of [1, 15, 29]) {
    const futureActivation = requestActivation(
      `future-activation-${futureSeconds}`,
      `fa-${futureSeconds}`,
      "high",
      { remaining: 80, observed_at: new Date(Date.now() + (futureSeconds * 1_000)).toISOString() },
      "$capacity-guard",
    );
    assert.match(futureActivation.output.hookSpecificOutput.additionalContext, /current quota value is unavailable/);

    const runtimeSession = `future-runtime-${futureSeconds}`;
    const runtimeBase = Date.now();
    arm(runtimeSession, `fr-${futureSeconds}-0`, "high", { remaining: 70, observed_at: new Date(runtimeBase - 2_000).toISOString() }, 30);
    writeQuotaSnapshot({
      remaining: 20,
      resets_at: Math.floor(Date.now() / 1000) + 3600,
      observed_at: new Date(runtimeBase - 1_000).toISOString(),
    }, new Date(), runtimeSession);
    const futureHigh = transcript(`fr-${futureSeconds}-1`, "high", {
      remaining: 80,
      observed_at: new Date(Date.now() + (futureSeconds * 1_000)).toISOString(),
    });
    const futureTrip = pre(runtimeSession, `fr-${futureSeconds}-1`, futureHigh);
    assert.match(futureTrip.hookSpecificOutput.permissionDecisionReason, /THRESHOLD_REACHED/);
  }

  fs.writeFileSync(path.join(testRoot, "quota-latest.json"), "{corrupt", "utf8");
  assert.equal(denied(pre("off-corrupt", "oc0", transcript("oc0", "high"))), false);

  writeQuotaSnapshot({ remaining: 44, resets_at: Math.floor(Date.now() / 1000) + 3600 }, new Date(), "different-session");
  const crossSession = requestActivation("cross-session", "cs0", "high", undefined, "$capacity-guard");
  assert.match(crossSession.output.hookSpecificOutput.additionalContext, /current quota value is unavailable/);

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

  for (const [session, prompt] of [
    ["fenced-mention", "```text\n[@使いすぎ防止モード](plugin://capacity-guard@personal/) 5%\n```"],
    ["inline-mention", "`[@使いすぎ防止モード](plugin://capacity-guard@personal/) 5%`"],
    ["blockquote-mention", "> [@使いすぎ防止モード](plugin://capacity-guard@personal/) 5%"],
    ["quoted-mention", "\"[@使いすぎ防止モード](plugin://capacity-guard@personal/) 5%\""],
    ["jp-quoted-mention", "「[@使いすぎ防止モード](plugin://capacity-guard@personal/) 5%」"],
  ]) {
    const result = requestActivation(session, `${session}-turn`, "high", { remaining: 73 }, prompt);
    assert.doesNotMatch(result.output.hookSpecificOutput.additionalContext, /PENDING_APPROVAL/);
  }

  for (const [session, prompt] of [
    ["apostrophe-id", "I'd like to enable Capacity Guard for this run."],
    ["apostrophe-dont", "don't wait; run this with Capacity Guard."],
  ]) {
    const result = requestActivation(session, `${session}-turn`, "high", { remaining: 73 }, prompt);
    assert.match(result.output.hookSpecificOutput.additionalContext, /PENDING_APPROVAL/);
  }

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

  const firstPromptData = path.join(testRoot, "first-prompt-empty-data");
  const firstPrompt = run({
    hook_event_name: "UserPromptSubmit",
    session_id: "first-prompt-empty",
    turn_id: "first0",
    transcript_path: transcript("first0", "high"),
    model: "gpt-test",
    prompt: "$capacity-guard",
  }, { CAPACITY_GUARD_DATA_DIR: firstPromptData });
  assert.match(firstPrompt.hookSpecificOutput.additionalContext, /current quota value is unavailable/);

  const futureReset = Math.floor(Date.now() / 1000) + 3600;
  assert.equal(denied(pre("bootstrap", "bootstrap-seed", transcript("bootstrap-seed", "high", { remaining: 64, resets_at: futureReset }))), false);
  const bootstrap = requestActivation("bootstrap", "b0", "high", undefined, "[@capacity-guard](plugin://capacity-guard@personal)");
  assert.match(bootstrap.output.hookSpecificOutput.additionalContext, /remaining_percent="64"/);
  assert.match(bootstrap.output.hookSpecificOutput.additionalContext, /PENDING_APPROVAL; stop_threshold=0%/);
  const bootstrapApprovalFile = transcript("b0", "high");
  assert.equal(denied(approvalPre("bootstrap", "b0", "high", bootstrapApprovalFile, 64, 0)), false);
  assert.match(approvalPost("bootstrap", "b0", "high", bootstrapApprovalFile, 64, 0, "accept (Recommended)", true).hookSpecificOutput.additionalContext, /ARMED/);
  assert.equal(denied(pre("bootstrap", "b1", transcript("b1", "high"), "codex_appcreate_thread")), false);
  assert.match(pre("bootstrap", "b2", transcript("b2", "high"), "Bash").hookSpecificOutput.permissionDecisionReason, /OBSERVATION_UNAVAILABLE/);

  writeQuotaSnapshot({ remaining: 58, resets_at: futureReset }, new Date(), "legacy-snapshot", 1);
  const legacySnapshot = requestActivation("legacy-snapshot", "ls0", "high", undefined, "$capacity-guard");
  assert.match(legacySnapshot.output.hookSpecificOutput.additionalContext, /remaining_percent="58"/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(testRoot, "quota-latest.json"), "utf8")).schema_version, 2);

  const legacyStateObservedAt = new Date(Date.now() - 1_000).toISOString();
  writeState("legacy-armed", {
    status: "ARMED",
    session_id: "legacy-armed",
    policy: { stop_threshold: 0, stop_on_reset: true },
    quota: { remaining_percent: 60, used_percent: 40, window_minutes: 10080, resets_at: futureReset, limit_id: "codex", observed_at: legacyStateObservedAt },
    missing_checkpoints: 0,
  });
  assert.equal(denied(pre("legacy-armed", "la1", transcript("la1", "high", { remaining: 59 }))), false);
  assert.equal(readState("legacy-armed").schema_version, 2);
  assert.equal(readState("legacy-armed").quota.remaining_percent, 59);

  writeState("legacy-invalid-armed", {
    status: "ARMED",
    session_id: "legacy-invalid-armed",
    policy: { stop_threshold: 0, stop_on_reset: true },
    quota: null,
  });
  assert.equal(denied(pre("legacy-invalid-armed", "lia1", transcript("lia1", "high"))), false);
  assert.match(pre("legacy-invalid-armed", "lia2", transcript("lia2", "high")).hookSpecificOutput.permissionDecisionReason, /OBSERVATION_UNAVAILABLE/);

  writeState("legacy-tripped", { status: "TRIPPED", session_id: "legacy-tripped", policy: { stop_threshold: 5 }, trip: { reason: "THRESHOLD_REACHED" } });
  assert.equal(denied(pre("legacy-tripped", "lt1", transcript("lt1", "high"))), true);
  assert.equal(readState("legacy-tripped").schema_version, 2);

  writeState("legacy-pending", { status: "PENDING_APPROVAL", session_id: "legacy-pending", policy: { stop_threshold: 5 } });
  run({ hook_event_name: "UserPromptSubmit", session_id: "legacy-pending", turn_id: "lp1", transcript_path: transcript("lp1", "high"), prompt: "continue normally" });
  assert.equal(readState("legacy-pending").schema_version, 2);
  assert.equal(readState("legacy-pending").status, "OFF");

  const localized = requestActivation("localized-approval", "la0", "high", { remaining: 53 }, "[@capacity-guard](plugin://capacity-guard@personal) 動作確認");
  const localizedLabels = ["有効化 (Recommended)", "拒否"];
  assert.equal(denied(approvalPre("localized-approval", "la0", "high", localized.file, 53, 0)), false);
  const localizedResult = approvalPost("localized-approval", "la0", "high", localized.file, 53, 0, "accept (Recommended)", true);
  assert.match(localizedResult.hookSpecificOutput.additionalContext, /ARMED/);

  const localizedDeny = requestActivation("localized-deny", "ld0", "high", { remaining: 53 }, "$capacity-guard");
  assert.equal(denied(approvalPre("localized-deny", "ld0", "high", localizedDeny.file, 53, 0, localizedLabels)), true);
  assert.equal(readState("localized-deny").status, "PENDING_APPROVAL");

  const unlistedRecommended = requestActivation("unlisted-recommended", "ur0", "high", { remaining: 53 }, "$capacity-guard");
  approvalPre("unlisted-recommended", "ur0", "high", unlistedRecommended.file, 53, 0);
  const unlistedResult = approvalPost("unlisted-recommended", "ur0", "high", unlistedRecommended.file, 53, 0, "危険 (Recommended)", true);
  assert.match(unlistedResult.hookSpecificOutput.additionalContext, /not armed/);
  assert.equal(readState("unlisted-recommended").status, "PENDING_APPROVAL");

  const missingToolUse = requestActivation("missing-tool-use", "mtu0", "high", { remaining: 53 }, "$capacity-guard");
  const missingToolUsePre = run({
    hook_event_name: "PreToolUse",
    session_id: "missing-tool-use",
    turn_id: "mtu0",
    transcript_path: missingToolUse.file,
    model: "gpt-test",
    tool_name: "request_user_input",
    tool_input: { questions: approvalQuestion(53, 0, "high") },
  });
  assert.equal(denied(missingToolUsePre), true);
  assert.match(missingToolUsePre.hookSpecificOutput.permissionDecisionReason, /tool_use_id/);

  const missingTurn = requestActivation("missing-turn", "mturn0", "high", { remaining: 53 }, "$capacity-guard");
  const missingTurnPre = run({
    hook_event_name: "PreToolUse",
    session_id: "missing-turn",
    tool_use_id: "missing-turn-tool",
    transcript_path: missingTurn.file,
    model: "gpt-test",
    tool_name: "request_user_input",
    tool_input: { questions: approvalQuestion(53, 0, "high") },
  });
  assert.equal(denied(missingTurnPre), true);
  assert.match(missingTurnPre.hookSpecificOutput.permissionDecisionReason, /turn_id/);

  const malformedApprovalShapes = [
    ["duplicate-id", (questions) => questions.push(structuredClone(questions[0]))],
    ["extra-question", (questions) => questions.push({ id: "other_permission", question: "Approve another permission?", options: [] })],
    ["empty-options", (questions) => { questions[0].options = []; }],
    ["reversed-options", (questions) => { questions[0].options.reverse(); }],
    ["third-option", (questions) => { questions[0].options.push({ label: "later", description: "Defer the decision." }); }],
    ["malicious-description", (questions) => { questions[0].options[0].description = "Enable Capacity Guard and grant another permission."; }],
    ["question-extra-field", (questions) => { questions[0].permission = "network"; }],
    ["option-extra-field", (questions) => { questions[0].options[0].permission = "filesystem"; }],
    ["question-prefix", (questions) => { questions[0].question = `Approve filesystem access too. ${questions[0].question}`; }],
    ["question-suffix", (questions) => { questions[0].question += " Also approve network access."; }],
  ];
  for (const [name, mutate] of malformedApprovalShapes) {
    const session = `canonical-${name}`;
    const activation = requestActivation(session, `${name}-0`, "high", { remaining: 53 }, "$capacity-guard");
    const questions = approvalQuestion(53, 0, "high");
    mutate(questions);
    const malformedPre = run({
      hook_event_name: "PreToolUse",
      session_id: session,
      turn_id: `${name}-0`,
      model: "gpt-test",
      transcript_path: activation.file,
      tool_use_id: `approval-${name}`,
      tool_name: "request_user_input",
      tool_input: { questions },
    });
    assert.equal(denied(malformedPre), true, name);
    assert.equal(readState(session).status, "PENDING_APPROVAL", name);
  }

  const postShape = requestActivation("canonical-post-shape", "cps0", "high", { remaining: 53 }, "$capacity-guard");
  approvalPre("canonical-post-shape", "cps0", "high", postShape.file, 53, 0, undefined, "canonical-post-tool");
  const postQuestions = approvalQuestion(53, 0, "high");
  postQuestions.push({ id: "other_permission", question: "Approve network too?", options: [] });
  const malformedPost = run({
    hook_event_name: "PostToolUse",
    session_id: "canonical-post-shape",
    turn_id: "cps0",
    transcript_path: postShape.file,
    tool_use_id: "canonical-post-tool",
    tool_name: "request_user_input",
    tool_input: { questions: postQuestions },
    tool_response: { answers: { capacity_guard_approval: { answers: ["accept (Recommended)"] } } },
  });
  assert.match(malformedPost.hookSpecificOutput.additionalContext, /not armed/);
  assert.equal(readState("canonical-post-shape").status, "PENDING_APPROVAL");

  const answerBound = requestActivation("canonical-answer", "ca0", "high", { remaining: 53 }, "$capacity-guard");
  approvalPre("canonical-answer", "ca0", "high", answerBound.file, 53, 0, undefined, "canonical-answer-tool");
  for (const answers of [["accept"], [" accept (Recommended) "], ["accept (Recommended)", "deny"], ["other"]]) {
    const invalidAnswer = run({
      hook_event_name: "PostToolUse",
      session_id: "canonical-answer",
      turn_id: "ca0",
      transcript_path: answerBound.file,
      tool_use_id: "canonical-answer-tool",
      tool_name: "request_user_input",
      tool_input: { questions: approvalQuestion(53, 0, "high") },
      tool_response: { answers: { capacity_guard_approval: { answers } } },
    });
    assert.match(invalidAnswer.hookSpecificOutput.additionalContext, /not armed/);
    assert.equal(readState("canonical-answer").status, "PENDING_APPROVAL");
  }
  const extraAnswerId = run({
    hook_event_name: "PostToolUse",
    session_id: "canonical-answer",
    turn_id: "ca0",
    transcript_path: answerBound.file,
    tool_use_id: "canonical-answer-tool",
    tool_name: "request_user_input",
    tool_input: { questions: approvalQuestion(53, 0, "high") },
    tool_response: { answers: {
      capacity_guard_approval: { answers: ["accept (Recommended)"] },
      other_permission: { answers: ["accept"] },
    } },
  });
  assert.match(extraAnswerId.hookSpecificOutput.additionalContext, /not armed/);
  assert.equal(readState("canonical-answer").status, "PENDING_APPROVAL");

  const parallelApproval = requestActivation("parallel-approval", "pa0", "high", { remaining: 53 }, "$capacity-guard");
  assert.equal(denied(approvalPre("parallel-approval", "pa0", "high", parallelApproval.file, 53, 0, undefined, "approval-A")), false);
  assert.equal(denied(approvalPre("parallel-approval", "pa0", "high", parallelApproval.file, 53, 0, undefined, "approval-B")), false);
  const staleApprovalA = approvalPost("parallel-approval", "pa0", "high", parallelApproval.file, 53, 0, "accept (Recommended)", false, undefined, "approval-A");
  assert.match(staleApprovalA.hookSpecificOutput.additionalContext, /not armed/);
  assert.equal(readState("parallel-approval").status, "PENDING_APPROVAL");
  const currentApprovalB = approvalPost("parallel-approval", "pa0", "high", parallelApproval.file, 53, 0, "accept (Recommended)", false, undefined, "approval-B");
  assert.match(currentApprovalB.hookSpecificOutput.additionalContext, /ARMED/);

  const questionBound = requestActivation("question-bound", "qb0", "high", { remaining: 53 }, "$capacity-guard");
  approvalPre("question-bound", "qb0", "high", questionBound.file, 53, 0, undefined, "question-bound-tool");
  const changedQuestionPost = approvalPost("question-bound", "qb0", "high", questionBound.file, 54, 0, "accept (Recommended)", false, undefined, "question-bound-tool");
  assert.doesNotMatch(changedQuestionPost.hookSpecificOutput.additionalContext, /ARMED/);
  assert.equal(readState("question-bound").status, "PENDING_APPROVAL");
  const missingPostId = run({
    hook_event_name: "PostToolUse",
    session_id: "question-bound",
    turn_id: "qb0",
    transcript_path: questionBound.file,
    tool_name: "request_user_input",
    tool_input: { questions: approvalQuestion(53, 0, "high") },
    tool_response: { answers: { capacity_guard_approval: { answers: ["accept (Recommended)"] } } },
  });
  assert.match(missingPostId.hookSpecificOutput.additionalContext, /not armed/);
  assert.equal(readState("question-bound").status, "PENDING_APPROVAL");

  const observationBound = requestActivation("observation-bound", "ob0", "high", { remaining: 53 }, "$capacity-guard");
  approvalPre("observation-bound", "ob0", "high", observationBound.file, 53, 0, undefined, "observation-bound-tool");
  const tamperedObservationState = readState("observation-bound");
  tamperedObservationState.approval_probe.displayed_quota.remaining_percent = 52;
  tamperedObservationState.approval_probe.displayed_quota.used_percent = 48;
  writeState("observation-bound", tamperedObservationState);
  const tamperedObservationPost = approvalPost("observation-bound", "ob0", "high", observationBound.file, 53, 0, "accept (Recommended)", false, undefined, "observation-bound-tool");
  assert.match(tamperedObservationPost.hookSpecificOutput.additionalContext, /not armed/);
  assert.equal(readState("observation-bound").status, "PENDING_APPROVAL");

  const approvalDrift = requestActivation("approval-drift", "ad0", "high", { remaining: 53 }, "$capacity-guard");
  approvalPre("approval-drift", "ad0", "high", approvalDrift.file, 53, 0, undefined, "approval-drift-tool");
  const approvalDriftPost = approvalPost("approval-drift", "ad0", "high", transcript("ad0", "high", { remaining: 52 }), 53, 0, "accept (Recommended)", false, undefined, "approval-drift-tool");
  assert.match(approvalDriftPost.hookSpecificOutput.additionalContext, /not armed/);
  assert.equal(readState("approval-drift").status, "PENDING_APPROVAL");

  writeQuotaSnapshot({ remaining: 64, resets_at: futureReset }, new Date(), "expires-before-approval");
  const expiresBeforeApproval = requestActivation("expires-before-approval", "eba0", "high", undefined, "$capacity-guard");
  assert.match(expiresBeforeApproval.output.hookSpecificOutput.additionalContext, /PENDING_APPROVAL/);
  writeQuotaSnapshot({ remaining: 64, resets_at: futureReset }, new Date(Date.now() - (6 * 60_000)), "expires-before-approval");
  assert.equal(denied(approvalPre("expires-before-approval", "eba0", "high", transcript("eba0", "high"), 64, 0)), true);

  writeQuotaSnapshot({ remaining: 64, resets_at: futureReset }, new Date(Date.now() - (6 * 60_000)), "stale-bootstrap");
  const staleBootstrap = requestActivation("stale-bootstrap", "sb0", "high", undefined, "$capacity-guard");
  assert.match(staleBootstrap.output.hookSpecificOutput.additionalContext, /current quota value is unavailable/);

  writeQuotaSnapshot({ remaining: 64, resets_at: futureReset }, new Date(), "stale-observation");
  const forgedFresh = JSON.parse(fs.readFileSync(path.join(testRoot, "quota-latest.json"), "utf8"));
  forgedFresh.quota.observed_at = new Date(Date.now() - (6 * 60_000)).toISOString();
  fs.writeFileSync(path.join(testRoot, "quota-latest.json"), `${JSON.stringify(forgedFresh, null, 2)}\n`, "utf8");
  const staleObservation = requestActivation("stale-observation", "so0", "high", undefined, "$capacity-guard");
  assert.match(staleObservation.output.hookSpecificOutput.additionalContext, /current quota value is unavailable/);

  writeQuotaSnapshot({ remaining: 64, resets_at: futureReset, limit_id: "other" }, new Date(), "wrong-limit");
  const wrongLimit = requestActivation("wrong-limit", "wl0", "high", undefined, "$capacity-guard");
  assert.match(wrongLimit.output.hookSpecificOutput.additionalContext, /current quota value is unavailable/);

  writeQuotaSnapshot({ remaining: 64, resets_at: futureReset, window: 0 }, new Date(), "wrong-window");
  const wrongWindow = requestActivation("wrong-window", "ww0", "high", undefined, "$capacity-guard");
  assert.match(wrongWindow.output.hookSpecificOutput.additionalContext, /current quota value is unavailable/);

  writeQuotaSnapshot({ remaining: 64, resets_at: Math.floor(Date.now() / 1000) - 1 }, new Date(), "expired-reset");
  const expiredReset = requestActivation("expired-reset", "er0", "high", undefined, "$capacity-guard");
  assert.match(expiredReset.output.hookSpecificOutput.additionalContext, /current quota value is unavailable/);

  const mismatch = requestActivation("mismatch", "mm0", "high", { remaining: 70 }, "残量30%まで使いすぎ防止モードで実行して");
  assert.equal(denied(approvalPre("mismatch", "mm0", "high", mismatch.file, 70, 31)), true);

  arm("threshold", "t0", "high", { remaining: 70 }, 30);
  assert.equal(denied(pre("threshold", "t1", transcript("t1", "medium", { remaining: 31 }))), false);
  const thresholdTrip = pre("threshold", "t2", transcript("t2", "low", { remaining: 30 }), "apply_patch");
  assert.match(thresholdTrip.hookSpecificOutput.permissionDecisionReason, /THRESHOLD_REACHED/);

  const orderingNow = Date.now();
  arm("new-global-wins", "ng0", "high", { remaining: 70, observed_at: new Date(orderingNow - 3_000).toISOString() }, 30);
  writeQuotaSnapshot({ remaining: 20, resets_at: futureReset, observed_at: new Date(orderingNow - 1_000).toISOString() }, new Date(), "new-global-wins");
  const oldHighTranscript = transcript("ng1", "high", { remaining: 80, observed_at: new Date(orderingNow - 2_000).toISOString() });
  const globalThresholdTrip = pre("new-global-wins", "ng1", oldHighTranscript, "Bash");
  assert.match(globalThresholdTrip.hookSpecificOutput.permissionDecisionReason, /THRESHOLD_REACHED/);
  assert.equal(readState("new-global-wins").quota.remaining_percent, 20);

  const rollbackNow = Date.now();
  arm("no-rollback", "nr0", "high", { remaining: 70, observed_at: new Date(rollbackNow - 3_000).toISOString() }, 0);
  writeQuotaSnapshot({ remaining: 20, resets_at: futureReset, observed_at: new Date(rollbackNow - 1_000).toISOString() }, new Date(), "no-rollback");
  const rollbackOldHigh = transcript("nr1", "high", { remaining: 80, observed_at: new Date(rollbackNow - 2_000).toISOString() });
  assert.equal(denied(pre("no-rollback", "nr1", rollbackOldHigh)), false);
  assert.equal(readState("no-rollback").quota.remaining_percent, 20);
  assert.equal(denied(pre("no-rollback", "nr2", rollbackOldHigh)), false);
  assert.equal(readState("no-rollback").quota.remaining_percent, 20);

  const armedConcurrentBase = Date.now() - 3_000;
  arm("armed-concurrent", "ac0", "high", { remaining: 70, observed_at: new Date(armedConcurrentBase).toISOString() }, 0);
  const armedConcurrentOutputs = await Promise.all([
    runAsync({
      hook_event_name: "PreToolUse",
      session_id: "armed-concurrent",
      turn_id: "ac1",
      transcript_path: transcript("ac1", "high", { remaining: 60, observed_at: new Date(armedConcurrentBase + 1_000).toISOString() }),
      model: "gpt-test",
      tool_name: "Bash",
    }),
    runAsync({
      hook_event_name: "PreToolUse",
      session_id: "armed-concurrent",
      turn_id: "ac2",
      transcript_path: transcript("ac2", "high", { remaining: 50, observed_at: new Date(armedConcurrentBase + 2_000).toISOString() }),
      model: "gpt-test",
      tool_name: "apply_patch",
    }),
  ]);
  assert.ok(armedConcurrentOutputs.every((output) => !denied(output)));
  assert.equal(readState("armed-concurrent").quota.remaining_percent, 50);

  arm("reset", "r0", "ultra", { remaining: 34 }, 0);
  const resetTrip = pre("reset", "child", transcript("child", "high", { remaining: 100, resets_at: Math.floor(Date.now() / 1000) + 7200 }), "collaboration.spawn_agent");
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
  writeQuotaSnapshot({ remaining: 80, resets_at: futureReset }, new Date(Date.now() - (6 * 60_000)), "expired-runtime");
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
  const fallbackActivation = requestActivation("fallback", "f0", "medium", { remaining: 60 }, "$capacity-guard");
  assert.match(fallbackActivation.output.hookSpecificOutput.additionalContext, /PENDING_APPROVAL/);
  run({ hook_event_name: "Stop", session_id: "fallback", last_assistant_message: fallbackText });
  const fallbackArm = run({
    hook_event_name: "UserPromptSubmit",
    session_id: "fallback",
    turn_id: "f1",
    transcript_path: transcript("f1", "low"),
    prompt: "accept",
  });
  assert.match(fallbackArm.hookSpecificOutput.additionalContext, /ARMED/);

  const mismatchedFallbackText = fallbackText.replace('remaining: "60%"', 'remaining: "61%"');
  requestActivation("fallback-display-mismatch", "fdm0", "medium", { remaining: 60 }, "$capacity-guard");
  run({ hook_event_name: "Stop", session_id: "fallback-display-mismatch", last_assistant_message: mismatchedFallbackText });
  assert.equal(readState("fallback-display-mismatch").status, "OFF");

  for (const [session, message] of [
    ["fallback-prefix", `Approve network access too.\n${fallbackText}`],
    ["fallback-suffix", `${fallbackText}\nAlso approve filesystem access.`],
    ["fallback-inline-prefix", `Another permission: ${fallbackText}`],
  ]) {
    requestActivation(session, `${session}-0`, "medium", { remaining: 60 }, "$capacity-guard");
    run({ hook_event_name: "Stop", session_id: session, last_assistant_message: message });
    assert.equal(readState(session).status, "OFF", session);
  }

  requestActivation("fallback-crlf", "fcrlf0", "medium", { remaining: 60 }, "$capacity-guard");
  run({ hook_event_name: "Stop", session_id: "fallback-crlf", last_assistant_message: fallbackText.replace(/\n/g, "\r\n") });
  assert.equal(readState("fallback-crlf").status, "PENDING_CONFIRMATION");

  requestActivation("fallback-bare-cr", "fbcr0", "medium", { remaining: 60 }, "$capacity-guard");
  run({ hook_event_name: "Stop", session_id: "fallback-bare-cr", last_assistant_message: fallbackText.replace(/\n/g, "\r") });
  assert.equal(readState("fallback-bare-cr").status, "OFF");

  for (const [index, rawAccept] of [" accept ", "accept\n", "\naccept", "\taccept", "accept\t"].entries()) {
    const session = `fallback-raw-${index}`;
    requestActivation(session, `${session}-0`, "medium", { remaining: 60 }, "$capacity-guard");
    run({ hook_event_name: "Stop", session_id: session, last_assistant_message: fallbackText });
    const rawMismatch = run({
      hook_event_name: "UserPromptSubmit",
      session_id: session,
      turn_id: `${session}-1`,
      transcript_path: transcript(`${session}-1`, "medium"),
      prompt: rawAccept,
    });
    assert.doesNotMatch(rawMismatch.hookSpecificOutput.additionalContext, /ARMED/);
    assert.equal(readState(session).status, "OFF");
  }

  requestActivation("fallback-fingerprint", "ffp0", "medium", { remaining: 60 }, "$capacity-guard");
  run({ hook_event_name: "Stop", session_id: "fallback-fingerprint", last_assistant_message: fallbackText });
  const fingerprintState = readState("fallback-fingerprint");
  fingerprintState.fallback_fingerprint = "0".repeat(64);
  writeState("fallback-fingerprint", fingerprintState);
  const fingerprintMismatch = run({
    hook_event_name: "UserPromptSubmit",
    session_id: "fallback-fingerprint",
    turn_id: "ffp1",
    transcript_path: transcript("ffp1", "medium"),
    prompt: "accept",
  });
  assert.doesNotMatch(fingerprintMismatch.hookSpecificOutput.additionalContext, /ARMED/);
  assert.equal(readState("fallback-fingerprint").status, "OFF");

  for (const [session, changedRemaining] of [["fallback-drift", 59], ["fallback-reset", 100]]) {
    requestActivation(session, `${session}-0`, "medium", { remaining: 60 }, "$capacity-guard");
    run({ hook_event_name: "Stop", session_id: session, last_assistant_message: fallbackText });
    const changed = run({
      hook_event_name: "UserPromptSubmit",
      session_id: session,
      turn_id: `${session}-1`,
      transcript_path: transcript(`${session}-1`, "medium", { remaining: changedRemaining }),
      prompt: "accept",
    });
    assert.doesNotMatch(changed.hookSpecificOutput.additionalContext, /ARMED/);
    assert.match(changed.hookSpecificOutput.additionalContext, /Request activation again/);
  }

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

  arm("lock-budget", "lb0", "high", { remaining: 70 }, 0);
  const budgetGlobalLock = path.join(testRoot, "quota-latest.json.lock");
  const budgetStateLock = path.join(testRoot, "lock-budget.json.lock");
  const budgetGlobalOwner = { schema_version: 1, pid: process.pid, owner_token: "00000000-0000-4000-8000-000000000081", created_at: new Date().toISOString() };
  const budgetStateOwner = { schema_version: 1, pid: process.pid, owner_token: "00000000-0000-4000-8000-000000000082", created_at: new Date().toISOString() };
  createDirectoryLock(budgetGlobalLock, budgetGlobalOwner);
  createDirectoryLock(budgetStateLock, budgetStateOwner);
  const budgetGlobalIdentity = readDirectoryIdentity(budgetGlobalLock);
  const budgetStateIdentity = readDirectoryIdentity(budgetStateLock);
  const budgetStart = performance.now();
  const budgetResult = pre("lock-budget", "lb1", transcript("lb1", "high", { remaining: 69 }));
  const budgetElapsed = performance.now() - budgetStart;
  assert.equal(denied(budgetResult), true);
  assert.match(budgetResult.hookSpecificOutput.permissionDecisionReason, /failed internally/);
  assert.ok(budgetElapsed < 3_000, `shared lock budget exceeded 3s: ${budgetElapsed}ms`);
  assert.equal(releaseDirectoryLock(budgetGlobalLock, budgetGlobalOwner.owner_token, budgetGlobalIdentity), true);
  assert.equal(releaseDirectoryLock(budgetStateLock, budgetStateOwner.owner_token, budgetStateIdentity), true);

  const lockedSession = "fresh-lock";
  fs.writeFileSync(path.join(testRoot, `${lockedSession}.json.lock`), "fixture", "utf8");
  const lockFailure = pre(lockedSession, "lock0", transcript("lock0", "high", { remaining: 70 }));
  assert.equal(denied(lockFailure), true);
  assert.match(lockFailure.hookSpecificOutput.permissionDecisionReason, /failed internally/);

  const deadPid = 2_147_483_647;
  assert.equal(processIsAlive(process.pid), true);
  assert.equal(processIsAlive(deadPid, () => { const error = new Error("no such process"); error.code = "ESRCH"; throw error; }), false);
  assert.equal(processIsAlive(deadPid, () => { const error = new Error("permission denied"); error.code = "EPERM"; throw error; }), true);
  const staleTime = new Date(Date.now() - 60_000);
  const hardExpiredTime = new Date(Date.now() - (11 * 60_000));

  const injectedDeadPath = path.join(testRoot, "injected-dead.lock");
  createDirectoryLock(injectedDeadPath, { schema_version: 1, pid: deadPid, owner_token: "00000000-0000-4000-8000-000000000090", created_at: staleTime.toISOString() });
  assert.equal(reclaimStaleDirectoryLock(injectedDeadPath, { isAlive: () => false }), true);
  assert.equal(fs.existsSync(injectedDeadPath), false);

  const inspectionGenerationPath = path.join(testRoot, "inspection-generation.lock");
  fs.mkdirSync(inspectionGenerationPath);
  fs.utimesSync(inspectionGenerationPath, staleTime, staleTime);
  let inspectionSuccessorIdentity = null;
  const mixedGenerationInspection = inspectDirectoryLock(inspectionGenerationPath, {
    afterDirectoryStat: ({ directory_identity: inspectedIdentity }) => {
      fs.rmdirSync(inspectionGenerationPath);
      fs.mkdirSync(inspectionGenerationPath);
      inspectionSuccessorIdentity = readDirectoryIdentity(inspectionGenerationPath);
      assert.notDeepEqual(inspectionSuccessorIdentity, inspectedIdentity);
    },
  });
  assert.equal(mixedGenerationInspection.kind, "empty");
  assert.notDeepEqual(mixedGenerationInspection.directory_identity, inspectionSuccessorIdentity);
  assert.equal(reclaimInspectedDirectoryLock(mixedGenerationInspection, { isAlive: () => false }), false);
  assert.equal(fs.existsSync(inspectionGenerationPath), true);
  fs.rmdirSync(inspectionGenerationPath);

  const successorLockPath = path.join(testRoot, "successor-ownership.lock");
  const oldOwner = { schema_version: 1, pid: deadPid, owner_token: "00000000-0000-4000-8000-000000000098", created_at: staleTime.toISOString() };
  createDirectoryLock(successorLockPath, oldOwner);
  const oldOwnerIdentity = readDirectoryIdentity(successorLockPath);
  // Barrier phase 1: both reapers inspect owner A before either is allowed to remove it.
  const reaperOne = inspectDirectoryLock(successorLockPath);
  const reaperTwo = inspectDirectoryLock(successorLockPath);
  // Barrier phase 2: owner A exits and successor B acquires before either reaper resumes.
  assert.equal(releaseDirectoryLock(successorLockPath, oldOwner.owner_token, oldOwnerIdentity), true);
  const successorOwner = { schema_version: 1, pid: process.pid, owner_token: "00000000-0000-4000-8000-000000000099", created_at: new Date().toISOString() };
  const successorMarker = createDirectoryLock(successorLockPath, successorOwner);
  const successorIdentity = readDirectoryIdentity(successorLockPath);
  // Both stale inspections may remove only A's marker; B must survive both resumptions.
  assert.equal(reclaimInspectedDirectoryLock(reaperOne, { isAlive: () => false }), false);
  assert.equal(reclaimInspectedDirectoryLock(reaperTwo, { isAlive: () => false }), false);
  assert.equal(JSON.parse(fs.readFileSync(successorMarker, "utf8")).owner_token, successorOwner.owner_token);
  assert.equal(releaseDirectoryLock(successorLockPath, successorOwner.owner_token, successorIdentity), true);

  const publishGapPath = path.join(testRoot, "publish-gap.lock");
  const ownerAToken = "00000000-0000-4000-8000-000000000091";
  fs.mkdirSync(publishGapPath);
  const ownerAIdentity = readDirectoryIdentity(publishGapPath);
  fs.utimesSync(publishGapPath, staleTime, staleTime);
  const emptyOwnerAInspection = inspectDirectoryLock(publishGapPath);
  assert.equal(emptyOwnerAInspection.kind, "empty");
  assert.equal(reclaimInspectedDirectoryLock(emptyOwnerAInspection, { isAlive: () => false }), true);
  const ownerBToken = "00000000-0000-4000-8000-000000000092";
  fs.mkdirSync(publishGapPath);
  const ownerBIdentity = readDirectoryIdentity(publishGapPath);
  assert.equal(publishDirectoryLock(publishGapPath, ownerBToken, ownerBIdentity), true);
  let ownerAUpdates = 0;
  if (publishDirectoryLock(publishGapPath, ownerAToken, ownerAIdentity)) ownerAUpdates += 1;
  assert.equal(ownerAUpdates, 0);
  assert.equal(releaseDirectoryLock(publishGapPath, ownerAToken, ownerAIdentity), false);
  assert.deepEqual(fs.readdirSync(publishGapPath), [`owner.${ownerBToken}.json`]);
  assert.equal(verifyPublishedDirectoryLock(publishGapPath, ownerBToken, ownerBIdentity), true);
  let ownerBUpdates = 0;
  if (verifyPublishedDirectoryLock(publishGapPath, ownerBToken, ownerBIdentity)) ownerBUpdates += 1;
  assert.equal(ownerBUpdates, 1);
  assert.equal(releaseDirectoryLock(publishGapPath, ownerBToken, ownerBIdentity), true);

  const unpublishedSuccessorPath = path.join(testRoot, "unpublished-successor.lock");
  const unpublishedAToken = "00000000-0000-4000-8000-000000000096";
  fs.mkdirSync(unpublishedSuccessorPath);
  const unpublishedAIdentity = readDirectoryIdentity(unpublishedSuccessorPath);
  fs.utimesSync(unpublishedSuccessorPath, staleTime, staleTime);
  assert.equal(reclaimInspectedDirectoryLock(inspectDirectoryLock(unpublishedSuccessorPath), { isAlive: () => false }), true);
  const unpublishedBToken = "00000000-0000-4000-8000-000000000097";
  fs.mkdirSync(unpublishedSuccessorPath);
  const unpublishedBIdentity = readDirectoryIdentity(unpublishedSuccessorPath);
  let unpublishedAUpdates = 0;
  if (publishDirectoryLock(unpublishedSuccessorPath, unpublishedAToken, unpublishedAIdentity)) unpublishedAUpdates += 1;
  assert.equal(unpublishedAUpdates, 0);
  assert.deepEqual(fs.readdirSync(unpublishedSuccessorPath), []);
  assert.equal(releaseDirectoryLock(unpublishedSuccessorPath, unpublishedAToken, unpublishedAIdentity), false);
  assert.equal(fs.existsSync(unpublishedSuccessorPath), true);
  assert.equal(publishDirectoryLock(unpublishedSuccessorPath, unpublishedBToken, unpublishedBIdentity), true);
  let unpublishedBUpdates = 0;
  if (verifyPublishedDirectoryLock(unpublishedSuccessorPath, unpublishedBToken, unpublishedBIdentity)) unpublishedBUpdates += 1;
  assert.equal(unpublishedBUpdates, 1);
  assert.equal(releaseDirectoryLock(unpublishedSuccessorPath, unpublishedBToken, unpublishedBIdentity), true);

  const releaseGapPath = path.join(testRoot, "release-gap.lock");
  const releaseOldToken = "00000000-0000-4000-8000-000000000088";
  fs.mkdirSync(releaseGapPath);
  const releaseOldIdentity = readDirectoryIdentity(releaseGapPath);
  assert.equal(publishDirectoryLock(releaseGapPath, releaseOldToken, releaseOldIdentity), true);
  let releaseSuccessorIdentity = null;
  const releaseOldResult = releaseDirectoryLock(releaseGapPath, releaseOldToken, releaseOldIdentity, {
    afterMarkerRemoved: () => {
      fs.rmdirSync(releaseGapPath);
      fs.mkdirSync(releaseGapPath);
      releaseSuccessorIdentity = readDirectoryIdentity(releaseGapPath);
    },
  });
  assert.equal(releaseOldResult, false);
  assert.equal(fs.existsSync(releaseGapPath), true);
  const releaseSuccessorToken = "00000000-0000-4000-8000-000000000089";
  assert.equal(publishDirectoryLock(releaseGapPath, releaseSuccessorToken, releaseSuccessorIdentity), true);
  assert.equal(releaseDirectoryLock(releaseGapPath, releaseSuccessorToken, releaseSuccessorIdentity), true);

  const partialMarkerPath = path.join(testRoot, "partial-marker.lock");
  const partialToken = "00000000-0000-4000-8000-000000000093";
  fs.mkdirSync(partialMarkerPath);
  const partialIdentity = readDirectoryIdentity(partialMarkerPath);
  fs.writeFileSync(path.join(partialMarkerPath, `owner.${partialToken}.json`), "{partial", "utf8");
  assert.equal(verifyPublishedDirectoryLock(partialMarkerPath, partialToken, partialIdentity), false);
  assert.equal(releaseDirectoryLock(partialMarkerPath, partialToken, partialIdentity), false);
  assert.equal(fs.existsSync(partialMarkerPath), true);

  const tamperedMarkerPath = path.join(testRoot, "tampered-marker.lock");
  const tamperedToken = "00000000-0000-4000-8000-000000000095";
  const expectedOwner = { schema_version: 1, pid: process.pid, owner_token: tamperedToken, created_at: new Date().toISOString() };
  fs.mkdirSync(tamperedMarkerPath);
  const tamperedIdentity = readDirectoryIdentity(tamperedMarkerPath);
  const tamperedFile = path.join(tamperedMarkerPath, `owner.${tamperedToken}.json`);
  fs.writeFileSync(tamperedFile, `${JSON.stringify({ ...expectedOwner, pid: process.pid + 1 })}\n`, "utf8");
  assert.equal(verifyPublishedDirectoryLock(tamperedMarkerPath, tamperedToken, tamperedIdentity, expectedOwner), false);
  assert.equal(releaseDirectoryLock(tamperedMarkerPath, tamperedToken, tamperedIdentity), true);

  const foreignPublishPath = path.join(testRoot, "foreign-publish.lock");
  const foreignToken = "00000000-0000-4000-8000-000000000094";
  fs.mkdirSync(foreignPublishPath);
  const foreignIdentity = readDirectoryIdentity(foreignPublishPath);
  fs.writeFileSync(path.join(foreignPublishPath, "foreign.marker"), "foreign", "utf8");
  assert.equal(publishDirectoryLock(foreignPublishPath, foreignToken, foreignIdentity), false);
  assert.equal(releaseDirectoryLock(foreignPublishPath, foreignToken, foreignIdentity), false);
  assert.deepEqual(fs.readdirSync(foreignPublishPath), ["foreign.marker"]);

  const staleSession = "stale-lock";
  const stalePath = path.join(testRoot, `${staleSession}.json.lock`);
  createDirectoryLock(stalePath, { schema_version: 1, pid: deadPid, owner_token: "00000000-0000-4000-8000-000000000001", created_at: hardExpiredTime.toISOString() });
  const staleRecovery = requestActivation(staleSession, "stale0", "high", { remaining: 70 }, "$capacity-guard");
  assert.match(staleRecovery.output.hookSpecificOutput.additionalContext, /PENDING_APPROVAL/);
  assert.equal(fs.existsSync(stalePath), false);

  const liveLockSession = "live-stale-lock";
  const liveLockPath = path.join(testRoot, `${liveLockSession}.json.lock`);
  createDirectoryLock(liveLockPath, { schema_version: 1, pid: process.pid, owner_token: "00000000-0000-4000-8000-000000000002", created_at: staleTime.toISOString() });
  assert.equal(denied(pre(liveLockSession, "lsl0", transcript("lsl0", "high", { remaining: 70 }))), true);
  assert.equal(fs.existsSync(liveLockPath), true);

  const epermLockPath = path.join(testRoot, "eperm.lock");
  createDirectoryLock(epermLockPath, { schema_version: 1, pid: deadPid, owner_token: "00000000-0000-4000-8000-000000000003", created_at: staleTime.toISOString() });
  assert.equal(reclaimStaleDirectoryLock(epermLockPath, { isAlive: () => true }), false);
  assert.equal(fs.existsSync(epermLockPath), true);

  const reusedPidLockPath = path.join(testRoot, "reused-pid.lock");
  createDirectoryLock(reusedPidLockPath, { schema_version: 1, pid: process.pid, owner_token: "00000000-0000-4000-8000-000000000004", created_at: hardExpiredTime.toISOString() });
  assert.equal(reclaimStaleDirectoryLock(reusedPidLockPath, { isAlive: () => true }), true);
  assert.equal(fs.existsSync(reusedPidLockPath), false);

  const malformedStaleSession = "malformed-stale-lock";
  const malformedStalePath = path.join(testRoot, `${malformedStaleSession}.json.lock`);
  createDirectoryLock(malformedStalePath, { owner_token: "00000000-0000-4000-8000-000000000005" }, "fixture");
  assert.equal(denied(pre(malformedStaleSession, "msl0", transcript("msl0", "high", { remaining: 70 }))), true);
  assert.equal(fs.existsSync(malformedStalePath), true);
  assert.equal(reclaimStaleDirectoryLock(malformedStalePath, { now: Date.now() + (11 * 60_000), isAlive: () => true }), true);

  pre("audit-private", "ap0", transcript("ap0", "high"), "mcp__private_customer__secret_tool");

  const auditText = fs.readFileSync(path.join(testRoot, "events.jsonl"), "utf8");
  assert.doesNotMatch(auditText, /mcp__private_customer__secret_tool|tool_name|tool_blocked/);
  const auditEvents = auditText
    .trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.ok(auditEvents.some((event) => event.event === "invoked" && event.hook_event_name === "UserPromptSubmit"));
  assert.ok(auditEvents.some((event) => event.event === "failed" && event.session_id === "malformed"));
  assert.equal(auditEvents.some((event) => event.event === "failed" && String(event.session_id).startsWith("concurrent-session-")), false);

  process.stdout.write("capacity-guard tests: PASS\n");
} finally {
  fs.rmSync(testRoot, { recursive: true, force: true });
}
