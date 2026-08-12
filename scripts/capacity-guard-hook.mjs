#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const APPROVAL_ID = "capacity_guard_approval";
const FALLBACK_ACCEPT = "To enable Capacity Guard, reply with exactly `accept`; otherwise reply `deny`.";
const DATA_DIR = process.env.CAPACITY_GUARD_DATA_DIR
  || process.env.PLUGIN_DATA
  || path.join(os.homedir(), ".codex", "plugin-data", "capacity-guard");
const MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024;
const LOCK_WAIT_MS = 500;
const LOCK_STALE_MS = 30_000;
const HOOK_IMPLEMENTATION_VERSION = 2;
let rawInput = "";

function readInput() {
  rawInput = fs.readFileSync(0, "utf8");
  return rawInput.trim() ? JSON.parse(rawInput) : {};
}

function emit(value = {}) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function safeId(value) {
  return String(value || "unknown").replace(/[^a-zA-Z0-9._-]/g, "_");
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function statePath(sessionId) {
  return path.join(DATA_DIR, `${safeId(sessionId)}.json`);
}

function offState(sessionId, reason = "not_armed") {
  return { status: "OFF", session_id: sessionId, reason, updated_at: new Date().toISOString() };
}

function readStateUnlocked(sessionId) {
  try {
    return JSON.parse(fs.readFileSync(statePath(sessionId), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return offState(sessionId);
    throw error;
  }
}

function writeStateUnlocked(sessionId, state) {
  ensureDataDir();
  const target = statePath(sessionId);
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  const next = { ...state, session_id: sessionId, updated_at: new Date().toISOString() };
  fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  fs.renameSync(temp, target);
  return next;
}

function waitBriefly(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function reclaimStaleLock(lockPath) {
  try {
    const age = Date.now() - fs.statSync(lockPath).mtimeMs;
    if (age <= LOCK_STALE_MS) return false;
    fs.rmSync(lockPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
}

function withState(sessionId, update) {
  ensureDataDir();
  const lockPath = `${statePath(sessionId)}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  let fd;
  while (fd === undefined) {
    try {
      fd = fs.openSync(lockPath, "wx");
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (reclaimStaleLock(lockPath)) continue;
      if (Date.now() >= deadline) throw error;
      waitBriefly(10);
    }
  }
  try {
    fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() })}\n`, "utf8");
    const current = readStateUnlocked(sessionId);
    const result = update(current) || {};
    const state = result.state ? writeStateUnlocked(sessionId, result.state) : current;
    return { ...result, state };
  } finally {
    fs.closeSync(fd);
    fs.rmSync(lockPath, { force: true });
  }
}

function appendAudit(event) {
  ensureDataDir();
  fs.appendFileSync(path.join(DATA_DIR, "events.jsonl"), `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`, "utf8");
}

function auditInvocation(input) {
  appendAudit({
    event: "invoked",
    hook_event_name: input.hook_event_name ?? "unknown",
    session_id: input.session_id ?? "unknown",
    turn_id: input.turn_id ?? null,
    pid: process.pid,
    implementation_version: HOOK_IMPLEMENTATION_VERSION,
    source: process.env.PLUGIN_ROOT ? "plugin" : "direct",
  });
}

function auditFailure(input, error) {
  try {
    appendAudit({
      event: "failed",
      hook_event_name: input.hook_event_name ?? "unknown",
      session_id: input.session_id ?? "unknown",
      turn_id: input.turn_id ?? null,
      pid: process.pid,
      implementation_version: HOOK_IMPLEMENTATION_VERSION,
      error_name: error?.name ?? "Error",
      error_code: error?.code ?? null,
    });
  } catch {}
}

function readTranscriptRecords(transcriptPath) {
  if (!transcriptPath) return [];
  try {
    const fd = fs.openSync(transcriptPath, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - MAX_TRANSCRIPT_BYTES);
      const buffer = Buffer.alloc(size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      let content = buffer.toString("utf8");
      if (start > 0) {
        const firstBreak = content.indexOf("\n");
        content = firstBreak >= 0 ? content.slice(firstBreak + 1) : "";
      }
      return content.split(/\r?\n/).filter(Boolean).flatMap((line) => {
        try { return [JSON.parse(line)]; } catch { return []; }
      });
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
}

function currentRuntime(records, turnId, fallbackModel = null) {
  let latest;
  for (const record of records) {
    if (record?.type !== "turn_context") continue;
    if (turnId && record?.payload?.turn_id !== turnId) continue;
    latest = record.payload;
  }
  return {
    turn_id: turnId ?? latest?.turn_id ?? null,
    model: latest?.model ?? fallbackModel ?? null,
    effort: String(latest?.effort ?? latest?.collaboration_mode?.settings?.reasoning_effort ?? "unknown").toLowerCase(),
  };
}

function latestQuota(records) {
  let latest;
  for (const record of records) {
    if (record?.type !== "event_msg" || record?.payload?.type !== "token_count") continue;
    const primary = record?.payload?.rate_limits?.primary;
    if (!primary || !Number.isFinite(Number(primary.used_percent))) continue;
    latest = {
      remaining_percent: Math.max(0, Math.min(100, 100 - Number(primary.used_percent))),
      used_percent: Number(primary.used_percent),
      window_minutes: primary.window_minutes ?? null,
      resets_at: primary.resets_at ?? null,
      limit_id: record?.payload?.rate_limits?.limit_id ?? "codex",
      observed_at: record.timestamp ?? null,
    };
  }
  return latest;
}

function isGuardApprovalTool(input) {
  if (String(input.tool_name || "").toLowerCase() !== "request_user_input") return false;
  return Array.isArray(input?.tool_input?.questions)
    && input.tool_input.questions.some((question) => question?.id === APPROVAL_ID);
}

function answerValues(input, id) {
  const answer = input?.tool_response?.answers?.[id];
  return Array.isArray(answer?.answers) ? answer.answers.map((value) => String(value).trim()) : [];
}

function isAccepted(input) {
  return answerValues(input, APPROVAL_ID)
    .map((value) => value.toLowerCase())
    .some((value) => value === "accept" || value === "accept (recommended)");
}

function requestsCapacityGuard(prompt) {
  if (/\$capacity-guard/i.test(prompt)) return true;
  if (/\[@capacity-guard\]\(plugin:\/\/capacity-guard@personal\)/i.test(prompt)) return true;
  if (/(?:^|\s)@capacity-guard\b/i.test(prompt)) return true;
  if (/(?:使いすぎ防止モード.{0,24}(?:実行|有効|開始|オン|使って|やって)|(?:実行|有効|開始|オン).{0,24}使いすぎ防止モード)/i.test(prompt)) return true;
  return /(?:capacity\s*guard.{0,32}(?:enable|activate|start|run|use|実行|有効|開始)|(?:enable|activate|start|run|use|実行|有効|開始).{0,32}capacity\s*guard)/i.test(prompt);
}

function requestedThreshold(prompt) {
  const targeted = [
    ...prompt.matchAll(/残量\s*(-?\d+(?:\.\d+)?)\s*[%％]\s*まで/g),
    ...prompt.matchAll(/stop\s*threshold\s*(?:is|=|:)?\s*(-?\d+(?:\.\d+)?)\s*%/gi),
  ].map((match) => Number(match[1]));
  if (targeted.length === 1) {
    const value = targeted[0];
    return { valid: Number.isInteger(value) && value >= 0 && value <= 100, value };
  }
  if (targeted.length > 1) return { valid: false, value: null };
  const percentValues = [...prompt.matchAll(/(-?\d+(?:\.\d+)?)\s*[%％]/g)].map((match) => Number(match[1]));
  if (percentValues.length === 0) return { valid: true, value: 0 };
  if (percentValues.length !== 1) return { valid: false, value: null };
  const value = percentValues[0];
  return { valid: Number.isInteger(value) && value >= 0 && value <= 100, value };
}

function canonicalToolName(name) {
  return String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isDrainTool(name) {
  const canonical = canonicalToolName(name);
  return canonical.endsWith("listagents") || canonical.endsWith("waitagent");
}

function sameWindow(previous, current) {
  return previous?.limit_id === current?.limit_id && previous?.window_minutes === current?.window_minutes;
}

function deny(reason) {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
}

function context(eventName, message) {
  return { hookSpecificOutput: { hookEventName: eventName, additionalContext: message } };
}

function tripState(state, reason, previous, current, toolName, extra = {}) {
  return {
    ...state,
    status: "TRIPPED",
    quota: current ?? state.quota ?? null,
    trip: { reason, previous: previous ?? null, current: current ?? null, tool_blocked: toolName, ...extra },
  };
}

function formatPercent(value) {
  if (!Number.isFinite(Number(value))) return "unavailable";
  return String(Number(Number(value).toFixed(6)));
}

function runtimeContext(runtime, quota, status) {
  return [
    `CAPACITY_GUARD_RUNTIME effort="${runtime.effort}" model="${runtime.model ?? "unknown"}" turn_id="${runtime.turn_id ?? "unknown"}".`,
    `CAPACITY_GUARD_QUOTA remaining_percent="${formatPercent(quota?.remaining_percent)}".`,
    `Capacity Guard state for this session is ${status}.`,
    "When Capacity Guard activation is requested, display the exact quota, requested stop threshold, and effort values in one approval question. This metadata is informational and does not arm the guard.",
  ].join(" ");
}

function handleUserPrompt(input) {
  const records = readTranscriptRecords(input.transcript_path);
  const runtime = currentRuntime(records, input.turn_id, input.model);
  const quota = latestQuota(records);
  const prompt = String(input.prompt || "").trim();
  const activationRequested = requestsCapacityGuard(prompt);
  const threshold = requestedThreshold(prompt);
  const result = withState(input.session_id, (state) => {
    if (state.status === "PENDING_CONFIRMATION") {
      if (prompt === "accept") {
        return {
          state: {
            ...state,
            status: "ARMED",
            runtime,
            quota,
            missing_checkpoints: 0,
            armed_via: "fallback",
          },
          action: "armed",
        };
      }
      return { state: offState(input.session_id, "fallback_denied"), action: "off" };
    }
    if (activationRequested) {
      if (!threshold.valid) return { state: offState(input.session_id, "invalid_threshold"), action: "invalid" };
      if (!quota) return { state: offState(input.session_id, "quota_unavailable_before_approval"), action: "unavailable" };
      return {
        state: {
          status: "PENDING_APPROVAL",
          session_id: input.session_id,
          policy: { stop_threshold: threshold.value, stop_on_reset: true },
          runtime,
          configuration_quota: quota,
          reason: "awaiting_verified_approval",
        },
        action: "confirm",
      };
    }
    if (state.status === "TRIPPED") {
      return { state: offState(input.session_id, "user_resumed_after_trip"), action: "off" };
    }
    if (state.status === "ARMED") {
      if (prompt === "deny" || /^disable capacity guard$/i.test(prompt)) {
        return { state: offState(input.session_id, "explicitly_disabled"), action: "off" };
      }
      return { state: { ...state, runtime }, action: "keep" };
    }
    return { state: { ...state, runtime }, action: "off" };
  });

  if (result.action === "armed") appendAudit({ event: "armed", session_id: input.session_id, via: "fallback", policy: result.state.policy, runtime });
  if (result.action === "off" && prompt === "deny") appendAudit({ event: "disabled", session_id: input.session_id, via: "user_prompt" });
  const statusText = result.state.status === "ARMED"
    ? `ARMED; stop_threshold=${result.state.policy?.stop_threshold ?? 0}%`
    : result.state.status === "PENDING_APPROVAL"
      ? `PENDING_APPROVAL; stop_threshold=${result.state.policy.stop_threshold}%`
    : result.state.status;
  const baseContext = runtimeContext(runtime, quota, statusText);
  if (result.action === "confirm") {
    emit(context("UserPromptSubmit", `${baseContext} Activation request verified from the user prompt. Ask only capacity_guard_approval now, showing Current quota remaining: \"${formatPercent(quota.remaining_percent)}%\"; Stop threshold: \"${threshold.value}%\"; Current reasoning effort: \"${runtime.effort}\"; and accept/deny. Do not start task work first.`));
  } else if (result.action === "invalid") {
    emit(context("UserPromptSubmit", `${baseContext} Capacity Guard remains OFF: specify zero or one whole-number percentage from 0% through 100%.`));
  } else if (result.action === "unavailable") {
    emit(context("UserPromptSubmit", `${baseContext} Capacity Guard remains OFF because the current quota value is unavailable and cannot be confirmed before activation.`));
  } else emit(context("UserPromptSubmit", baseContext));
}

function handleApprovalPre(input, records) {
  const runtime = currentRuntime(records, input.turn_id, input.model);
  const currentQuota = latestQuota(records);
  const approvalQuestion = input.tool_input.questions.find((question) => question?.id === APPROVAL_ID);
  const displayed = String(approvalQuestion?.question || "").toLowerCase();
  const result = withState(input.session_id, (state) => {
    if (state.status === "TRIPPED") return { action: "tripped" };
    if (state.status !== "PENDING_APPROVAL") return { action: "not_configured" };
    if (!currentQuota) return { state: offState(input.session_id, "quota_unavailable_before_approval"), action: "unavailable" };
    const threshold = Number(state.policy?.stop_threshold);
    const required = [
      `current quota remaining: \"${formatPercent(currentQuota.remaining_percent)}%\"`,
      `stop threshold: \"${threshold}%\"`,
      `current reasoning effort: \"${runtime.effort}\"`,
    ];
    if (!required.every((fragment) => displayed.includes(fragment))) return { action: "mismatch", required };
    return {
      state: {
        ...state,
        approval_probe: { turn_id: input.turn_id, runtime, quota: currentQuota, question_verified: true },
      },
      action: "verified",
    };
  });

  if (result.action === "tripped") emit(deny("Capacity Guard is TRIPPED. Start a new user turn before configuring another guarded run."));
  else if (result.action === "not_configured") emit(deny("Configure capacity_guard_threshold before requesting approval."));
  else if (result.action === "unavailable") emit(deny("The current quota value is unavailable, so Capacity Guard cannot be enabled."));
  else if (result.action === "mismatch") emit(deny(`Approval question must display the verified values exactly: ${result.required.join("; ")}.`));
  else emit({});
}

function handleApprovalPost(input) {
  if (!isGuardApprovalTool(input)) return emit({});
  const accepted = isAccepted(input);
  const result = withState(input.session_id, (state) => {
    const probe = state.approval_probe;
    if (!accepted) return { state: offState(input.session_id, "approval_denied"), action: "off" };
    if (state.status !== "PENDING_APPROVAL" || !probe?.question_verified || probe.turn_id !== input.turn_id) {
      return { state: offState(input.session_id, "approval_not_verified"), action: "unverified" };
    }
    return {
      state: {
        status: "ARMED",
        session_id: input.session_id,
        policy: state.policy,
        runtime: probe.runtime,
        quota: probe.quota,
        missing_checkpoints: 0,
        armed_via: "request_user_input",
      },
      action: "armed",
    };
  });

  if (result.action === "armed") {
    appendAudit({ event: "armed", session_id: input.session_id, via: "request_user_input", policy: result.state.policy, runtime: result.state.runtime, quota: result.state.quota });
    emit(context("PostToolUse", `Capacity Guard: ARMED. Current quota remaining: ${formatPercent(result.state.quota.remaining_percent)}%. Stop threshold: ${result.state.policy.stop_threshold}%. Observed effort: ${result.state.runtime.effort}. Reset policy: stop.`));
  } else if (result.action === "unverified") {
    emit(context("PostToolUse", "Capacity Guard remains OFF because the current quota and threshold confirmation was not verified."));
  } else {
    emit(context("PostToolUse", "Capacity Guard was denied and remains OFF."));
  }
}

function handlePreTool(input) {
  const records = readTranscriptRecords(input.transcript_path);
  if (isGuardApprovalTool(input)) return handleApprovalPre(input, records);

  const result = withState(input.session_id, (state) => {
    if (state.status === "TRIPPED") return { action: isDrainTool(input.tool_name) ? "allow_drain" : "deny_tripped" };
    if (state.status !== "ARMED") return { action: "allow_off" };

    const runtime = currentRuntime(records, input.turn_id, input.model);
    const current = latestQuota(records);
    if (!current) {
      const missing = Number(state.missing_checkpoints || 0) + 1;
      const next = { ...state, runtime, missing_checkpoints: missing };
      if (missing >= 2) {
        return { state: tripState(next, "OBSERVATION_UNAVAILABLE", state.quota, null, input.tool_name, { missing_checkpoints: missing }), action: "trip" };
      }
      return { state: next, action: "allow_bootstrap" };
    }

    const previous = state.quota;
    const next = { ...state, runtime, quota: current, missing_checkpoints: 0 };

    if (previous && sameWindow(previous, current)
      && Number(previous.remaining_percent) < 100
      && Number(current.remaining_percent) === 100
      && state.policy?.stop_on_reset !== false) {
      return { state: tripState(next, "RESET_DETECTED", previous, current, input.tool_name), action: "trip" };
    }
    if (Number.isFinite(Number(state.policy?.stop_threshold))
      && Number(current.remaining_percent) <= Number(state.policy.stop_threshold)) {
      return { state: tripState(next, "THRESHOLD_REACHED", previous, current, input.tool_name), action: "trip" };
    }
    return { state: next, action: "allow" };
  });

  if (result.action === "trip") {
    appendAudit({ event: "tripped", session_id: input.session_id, ...result.state.trip, policy: result.state.policy });
    emit(deny(`Capacity Guard TRIPPED: ${result.state.trip.reason}. This tool was not started. Allow already-started indivisible operations to converge, then report current location, completed scope, and next task before ending the turn. resets_at is auxiliary evidence only; do not infer a reset cause.`));
  } else if (result.action === "deny_tripped") {
    emit(deny("Capacity Guard is TRIPPED. New tools, spawns, follow-ups, waves, and next tasks are blocked. Only list_agents and wait_agent are allowed for minimal drain."));
  } else if (result.action === "allow_bootstrap") {
    emit(context("PreToolUse", "Capacity Guard has no quota snapshot yet. One indivisible bootstrap tool is allowed; the next missing checkpoint will trip OBSERVATION_UNAVAILABLE."));
  } else emit({});
}

function parseFallback(message) {
  if (!message.includes(FALLBACK_ACCEPT)) return null;
  const thresholdMatch = message.match(/stop_threshold=(\d+)%/i);
  const effortMatch = message.match(/reasoning effort:\s*["']([^"']+)["']/i);
  const threshold = Number(thresholdMatch?.[1] ?? 0);
  if (!Number.isInteger(threshold) || threshold < 0 || threshold > 100) return null;
  return {
    policy: { stop_threshold: threshold, stop_on_reset: true },
    runtime: { effort: effortMatch?.[1]?.toLowerCase() ?? "unknown", model: null, turn_id: null },
  };
}

function handleStop(input, isSubagent) {
  const message = String(input.last_assistant_message || "");
  const result = withState(input.session_id, (state) => {
    if (state.status === "TRIPPED") return { action: "stop" };
    if (isSubagent) return { action: "continue" };
    const fallback = parseFallback(message);
    if (fallback) {
      return {
        state: { status: "PENDING_CONFIRMATION", session_id: input.session_id, ...fallback, reason: "awaiting_accept" },
        action: "pending",
      };
    }
    return { action: "continue" };
  });
  if (result.action === "stop") emit({ continue: false, stopReason: "Capacity Guard is TRIPPED; automatic continuation is stopped." });
  else emit({});
}

function handleSessionEnd(input) {
  try {
    const state = readStateUnlocked(input.session_id);
    if (state.status !== "OFF") appendAudit({ event: "session_end", session_id: input.session_id, final_status: state.status });
    fs.rmSync(statePath(input.session_id), { force: true });
  } catch {}
  emit({});
}

function recoverInputMetadata(raw) {
  const value = (key) => {
    const match = raw.match(new RegExp(`"${key}"\\s*:\\s*"([^"\\\\]*(?:\\\\.[^"\\\\]*)*)"`, "i"));
    if (!match) return undefined;
    try { return JSON.parse(`"${match[1]}"`); } catch { return match[1]; }
  };
  return {
    hook_event_name: value("hook_event_name"),
    session_id: value("session_id"),
    turn_id: value("turn_id"),
    prompt: value("prompt"),
  };
}

function emitFailure(input) {
  const message = "Capacity Guard hook failed internally, so its protection state could not be verified.";
  if (input.hook_event_name === "PreToolUse") {
    emit(deny(`${message} New tool execution is stopped.`));
    return;
  }
  if (input.hook_event_name === "UserPromptSubmit") {
    if (requestsCapacityGuard(String(input.prompt || ""))) {
      emit({
        continue: false,
        stopReason: `${message} Activation was stopped before task work began.`,
        systemMessage: `${message} Capacity Guard was not enabled; retry after resolving the hook failure.`,
      });
      return;
    }
    emit({ systemMessage: `${message} Do not assume Capacity Guard is active.` });
    return;
  }
  if (input.hook_event_name === "Stop" || input.hook_event_name === "SubagentStop") {
    emit({ continue: false, stopReason: `${message} Automatic continuation is stopped.` });
    return;
  }
  emit({ systemMessage: `${message} Capacity Guard remains OFF.` });
}

let hookInput = {};
try {
  hookInput = readInput();
  auditInvocation(hookInput);
  switch (hookInput.hook_event_name) {
    case "UserPromptSubmit": handleUserPrompt(hookInput); break;
    case "PreToolUse": handlePreTool(hookInput); break;
    case "PostToolUse": handleApprovalPost(hookInput); break;
    case "Stop": handleStop(hookInput, false); break;
    case "SubagentStop": handleStop(hookInput, true); break;
    case "SessionEnd": handleSessionEnd(hookInput); break;
    default: emit({});
  }
} catch (error) {
  if (!hookInput.hook_event_name && rawInput) hookInput = { ...hookInput, ...recoverInputMetadata(rawInput) };
  process.stderr.write(`capacity-guard hook error: ${error?.stack || error}\n`);
  auditFailure(hookInput, error);
  emitFailure(hookInput);
}
