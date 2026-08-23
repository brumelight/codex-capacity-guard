#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const APPROVAL_ID = "capacity_guard_approval";
const APPROVAL_ACCEPT_LABEL = "accept (Recommended)";
const APPROVAL_DENY_LABEL = "deny";
const APPROVAL_OPTIONS = Object.freeze([
  Object.freeze({ label: APPROVAL_ACCEPT_LABEL, description: "Enable Capacity Guard for this run." }),
  Object.freeze({ label: APPROVAL_DENY_LABEL, description: "Keep Capacity Guard off." }),
]);
const FALLBACK_ACCEPT = "To enable Capacity Guard, reply with exactly `accept`; otherwise reply `deny`.";
const DATA_DIR = process.env.CAPACITY_GUARD_DATA_DIR
  || process.env.PLUGIN_DATA
  || path.join(os.homedir(), ".codex", "plugin-data", "capacity-guard");
const MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024;
const LOCK_WAIT_MS = 1_500;
const HOOK_LOCK_BUDGET_MS = 2_500;
export function monotonicDeadline(budgetMs, monotonicNow = () => performance.now()) {
  return monotonicNow() + budgetMs;
}
export function monotonicDeadlineReached(deadline, monotonicNow = () => performance.now()) {
  return monotonicNow() >= deadline;
}
const HOOK_LOCK_DEADLINE = monotonicDeadline(HOOK_LOCK_BUDGET_MS);
const LOCK_STALE_MS = 30_000;
const LOCK_HARD_MAX_MS = 10 * 60_000;
const QUOTA_SNAPSHOT_MAX_AGE_MS = 5 * 60_000;
const STATE_SCHEMA_VERSION = 2;
const QUOTA_SNAPSHOT_SCHEMA_VERSION = 2;
const LOCK_SCHEMA_VERSION = 1;
const HOOK_IMPLEMENTATION_VERSION = 4;
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
  return { schema_version: STATE_SCHEMA_VERSION, status: "OFF", session_id: sessionId, reason, updated_at: new Date().toISOString() };
}

function migrateState(value, sessionId) {
  if (!value || typeof value !== "object") return offState(sessionId, "invalid_state");
  if (value.schema_version === STATE_SCHEMA_VERSION) return { ...value, session_id: sessionId };
  if (value.status === "PENDING_APPROVAL" || value.status === "PENDING_CONFIRMATION") {
    return offState(sessionId, "legacy_pending_requires_reapproval");
  }
  if (value.status === "ARMED" || value.status === "TRIPPED") {
    const observation = normalizeObservation(value.quota, sessionId, { allowStale: true });
    return {
      ...value,
      schema_version: STATE_SCHEMA_VERSION,
      session_id: sessionId,
      missing_checkpoints: Number.isInteger(value.missing_checkpoints) ? value.missing_checkpoints : 0,
      last_observation: observation ? observationReference(observation) : null,
    };
  }
  return offState(sessionId, value.reason ?? "legacy_off_migrated");
}

function readStateUnlocked(sessionId) {
  try {
    const stored = JSON.parse(fs.readFileSync(statePath(sessionId), "utf8"));
    const migrated = migrateState(stored, sessionId);
    if (stored?.schema_version !== STATE_SCHEMA_VERSION) {
      Object.defineProperty(migrated, "migration_required", { value: true, enumerable: false });
    }
    return migrated;
  } catch (error) {
    if (error?.code === "ENOENT") return offState(sessionId);
    throw error;
  }
}

function writeStateUnlocked(sessionId, state) {
  ensureDataDir();
  const target = statePath(sessionId);
  const next = { ...state, schema_version: STATE_SCHEMA_VERSION, session_id: sessionId, updated_at: new Date().toISOString() };
  writeJsonAtomic(target, next);
  return next;
}

function writeJsonAtomic(target, value) {
  const temp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.renameSync(temp, target);
  } finally {
    try { fs.rmSync(temp, { force: true }); } catch {}
  }
}

function waitBriefly(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function processIsAlive(pid, signalProcess = process.kill) {
  try {
    signalProcess(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    return true;
  }
}

function ownerMarkerName(ownerToken) {
  return `owner.${ownerToken}.json`;
}

function ownerTokenFromMarker(name) {
  const match = /^owner\.([a-f0-9-]{16,})\.json$/i.exec(name);
  return match?.[1] ?? null;
}

export function readDirectoryIdentity(lockDir) {
  const stat = fs.statSync(lockDir, { bigint: true });
  if (!stat.isDirectory()) throw new Error("Capacity Guard lock path is not a directory.");
  return directoryIdentityFromStat(stat);
}

function directoryIdentityFromStat(stat) {
  return {
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    birthtime_ns: stat.birthtimeNs.toString(),
  };
}

function sameDirectoryIdentity(left, right) {
  return Boolean(left && right
    && left.dev === right.dev
    && left.ino === right.ino
    && left.birthtime_ns === right.birthtime_ns);
}

function currentDirectoryMatches(lockDir, expectedIdentity) {
  try {
    return sameDirectoryIdentity(readDirectoryIdentity(lockDir), expectedIdentity);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export function inspectDirectoryLock(lockDir, options = {}) {
  try {
    const now = options.now ?? Date.now();
    const directoryStat = fs.statSync(lockDir, { bigint: true });
    if (!directoryStat.isDirectory()) return { lock_dir: lockDir, kind: "legacy_or_invalid" };
    const directoryIdentity = directoryIdentityFromStat(directoryStat);
    const directoryMtimeMs = Number(directoryStat.mtimeNs / 1_000_000n);
    options.afterDirectoryStat?.({ directory_identity: directoryIdentity, directory_mtime_ms: directoryMtimeMs });
    const entries = fs.readdirSync(lockDir, { withFileTypes: true });
    if (entries.length === 0) return { lock_dir: lockDir, kind: "empty", directory_mtime_ms: directoryMtimeMs, directory_identity: directoryIdentity };
    if (entries.length !== 1 || !entries[0].isFile()) return { lock_dir: lockDir, kind: "foreign", directory_identity: directoryIdentity };
    const markerName = entries[0].name;
    const markerToken = ownerTokenFromMarker(markerName);
    if (!markerToken) return { lock_dir: lockDir, kind: "foreign" };
    const markerPath = path.join(lockDir, markerName);
    const markerStat = fs.statSync(markerPath);
    let owner = null;
    try { owner = JSON.parse(fs.readFileSync(markerPath, "utf8")); } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    if (owner?.schema_version !== LOCK_SCHEMA_VERSION
      || !Number.isInteger(owner.pid) || owner.pid <= 0
      || owner.owner_token !== markerToken
      || !Number.isFinite(Date.parse(owner.created_at))
      || Date.parse(owner.created_at) > now) owner = null;
    return { lock_dir: lockDir, kind: owner ? "owned" : "malformed", marker_name: markerName, marker_path: markerPath, marker_stat: markerStat, owner, directory_identity: directoryIdentity };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function removeEmptyLockDirectory(lockDir, expectedIdentity) {
  if (!currentDirectoryMatches(lockDir, expectedIdentity)) return false;
  try {
    fs.rmdirSync(lockDir);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    if (error?.code === "ENOTEMPTY" || error?.code === "EEXIST" || error?.code === "EPERM") return false;
    throw error;
  }
}

function removeOwnedMarkerOnly(lockDir, ownerToken, expectedIdentity, verifyOwner = false) {
  if (!currentDirectoryMatches(lockDir, expectedIdentity)) return false;
  const markerPath = path.join(lockDir, ownerMarkerName(ownerToken));
  try {
    if (verifyOwner) {
      const owner = JSON.parse(fs.readFileSync(markerPath, "utf8"));
      if (owner?.schema_version !== LOCK_SCHEMA_VERSION || owner.owner_token !== ownerToken) return false;
    } else {
      fs.statSync(markerPath);
    }
    fs.rmSync(markerPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return false;
    throw error;
  }
}

export function releaseDirectoryLock(lockDir, ownerToken, expectedIdentity, options = {}) {
  if (!removeOwnedMarkerOnly(lockDir, ownerToken, expectedIdentity, true)) return false;
  options.afterMarkerRemoved?.();
  if (!currentDirectoryMatches(lockDir, expectedIdentity)) return false;
  return removeEmptyLockDirectory(lockDir, expectedIdentity);
}

export function reclaimInspectedDirectoryLock(inspection, options = {}) {
  if (!inspection) return true;
  const now = options.now ?? Date.now();
  const isAlive = options.isAlive ?? processIsAlive;
  if (inspection.kind === "legacy_or_invalid" || inspection.kind === "foreign") return false;
  if (!currentDirectoryMatches(inspection.lock_dir, inspection.directory_identity)) return false;
  if (inspection.kind === "empty") {
    if (now - inspection.directory_mtime_ms <= LOCK_STALE_MS) return false;
    return removeEmptyLockDirectory(inspection.lock_dir, inspection.directory_identity);
  }
  const createdAt = Date.parse(inspection.owner?.created_at);
  const markerAge = inspection.owner && Number.isFinite(createdAt)
    ? now - createdAt
    : now - inspection.marker_stat.mtimeMs;
  if (markerAge <= LOCK_STALE_MS) return false;
  if (markerAge < LOCK_HARD_MAX_MS && inspection.owner && isAlive(inspection.owner.pid)) return false;
  try { fs.rmSync(inspection.marker_path, { force: true }); } catch {}
  if (!currentDirectoryMatches(inspection.lock_dir, inspection.directory_identity)) return false;
  return removeEmptyLockDirectory(inspection.lock_dir, inspection.directory_identity);
}

export function reclaimStaleDirectoryLock(lockDir, options = {}) {
  return reclaimInspectedDirectoryLock(inspectDirectoryLock(lockDir, options), options);
}

export function verifyPublishedDirectoryLock(lockDir, ownerToken, expectedIdentity, expectedOwner = null) {
  try {
    if (!currentDirectoryMatches(lockDir, expectedIdentity)) return false;
    const entries = fs.readdirSync(lockDir, { withFileTypes: true });
    const expectedMarker = ownerMarkerName(ownerToken);
    if (entries.length !== 1 || !entries[0].isFile() || entries[0].name !== expectedMarker) return false;
    const owner = JSON.parse(fs.readFileSync(path.join(lockDir, expectedMarker), "utf8"));
    if (owner?.schema_version !== LOCK_SCHEMA_VERSION || owner.owner_token !== ownerToken) return false;
    return !expectedOwner || (
      owner.pid === expectedOwner.pid
      && owner.created_at === expectedOwner.created_at
      && owner.owner_token === expectedOwner.owner_token
      && owner.schema_version === expectedOwner.schema_version
    );
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return false;
    throw error;
  }
}

export function publishDirectoryLock(lockDir, ownerToken, expectedIdentity, owner = {}) {
  if (!currentDirectoryMatches(lockDir, expectedIdentity)) return false;
  const marker = {
    schema_version: LOCK_SCHEMA_VERSION,
    pid: owner.pid ?? process.pid,
    owner_token: ownerToken,
    created_at: owner.created_at ?? new Date().toISOString(),
  };
  try {
    fs.writeFileSync(path.join(lockDir, ownerMarkerName(ownerToken)), `${JSON.stringify(marker)}\n`, { encoding: "utf8", flag: "wx" });
    const published = verifyPublishedDirectoryLock(lockDir, ownerToken, expectedIdentity, marker);
    if (!published) removeOwnedMarkerOnly(lockDir, ownerToken, expectedIdentity);
    return published;
  } catch (error) {
    try { removeOwnedMarkerOnly(lockDir, ownerToken, expectedIdentity); } catch {}
    throw error;
  }
}

function withFileLock(lockDir, update) {
  const deadline = Math.min(monotonicDeadline(LOCK_WAIT_MS), HOOK_LOCK_DEADLINE);
  const ownerToken = crypto.randomUUID();
  let acquired = false;
  let directoryIdentity = null;
  while (!acquired) {
    try {
      fs.mkdirSync(lockDir);
      directoryIdentity = readDirectoryIdentity(lockDir);
      acquired = true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (reclaimStaleDirectoryLock(lockDir)) continue;
      if (monotonicDeadlineReached(deadline)) throw error;
      waitBriefly(10);
    }
  }
  let published = false;
  try {
    published = publishDirectoryLock(lockDir, ownerToken, directoryIdentity);
    if (!published) {
      const error = new Error("Capacity Guard lock ownership changed before state publication.");
      error.code = "ELOCKOWNERSHIP";
      throw error;
    }
    return update();
  } finally {
    try {
      if (published) releaseDirectoryLock(lockDir, ownerToken, directoryIdentity);
      else removeOwnedMarkerOnly(lockDir, ownerToken, directoryIdentity);
    } catch {}
  }
}

function withState(sessionId, update) {
  ensureDataDir();
  return withFileLock(`${statePath(sessionId)}.lock`, () => {
    const current = readStateUnlocked(sessionId);
    const result = update(current) || {};
    const state = result.state || current.migration_required
      ? writeStateUnlocked(sessionId, result.state ?? current)
      : current;
    return { ...result, state };
  });
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
    tool_class: isGuardApprovalTool(input) ? "guard_approval" : input.hook_event_name === "PreToolUse" ? "tool" : null,
    transcript_present: Boolean(input.transcript_path),
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
      error_syscall: error?.syscall ?? null,
      error_path_basename: error?.path ? path.basename(String(error.path)) : null,
      error_dest_basename: error?.dest ? path.basename(String(error.dest)) : null,
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

function observationIdentity(quota, sourceSessionId) {
  return crypto.createHash("sha256").update(JSON.stringify([
    sourceSessionId,
    quota.observed_at,
    quota.limit_id,
    quota.window_minutes,
    quota.remaining_percent,
    quota.used_percent,
    quota.resets_at,
  ])).digest("hex");
}

function normalizeObservation(quota, sourceSessionId, options = {}) {
  if (!validQuota(quota) || typeof sourceSessionId !== "string" || !sourceSessionId) return null;
  const observedMs = Date.parse(quota.observed_at);
  if (!Number.isFinite(observedMs)) return null;
  const now = options.now ?? Date.now();
  if (observedMs > now) return null;
  if (!options.allowStale && now - observedMs > QUOTA_SNAPSHOT_MAX_AGE_MS) return null;
  if (!options.allowExpiredReset && Number(quota.resets_at) * 1000 <= now) return null;
  const normalizedQuota = {
    remaining_percent: Number(quota.remaining_percent),
    used_percent: Number(quota.used_percent),
    window_minutes: Number(quota.window_minutes),
    resets_at: Number(quota.resets_at),
    limit_id: quota.limit_id,
    observed_at: new Date(observedMs).toISOString(),
  };
  return {
    quota: normalizedQuota,
    source_session_id: sourceSessionId,
    observed_ms: observedMs,
    id: observationIdentity(normalizedQuota, sourceSessionId),
  };
}

function observationReference(observation) {
  return observation ? {
    id: observation.id,
    source_session_id: observation.source_session_id,
    observed_at: observation.quota.observed_at,
  } : null;
}

function compareObservations(left, right) {
  if (!left) return right ? -1 : 0;
  if (!right) return 1;
  if (left.observed_ms !== right.observed_ms) return left.observed_ms > right.observed_ms ? 1 : -1;
  const leftRemaining = Number(left.quota.remaining_percent);
  const rightRemaining = Number(right.quota.remaining_percent);
  if (leftRemaining !== rightRemaining) return leftRemaining < rightRemaining ? 1 : -1;
  return 0;
}

function selectBestObservation(...candidates) {
  return candidates.filter(Boolean).reduce((best, candidate) => (
    !best || compareObservations(candidate, best) > 0 ? candidate : best
  ), null);
}

function latestQuota(records, sessionId) {
  const candidates = [];
  for (const record of records) {
    if (record?.type !== "event_msg" || record?.payload?.type !== "token_count") continue;
    const primary = record?.payload?.rate_limits?.primary;
    if (!primary || !Number.isFinite(Number(primary.used_percent))) continue;
    const observation = normalizeObservation({
      remaining_percent: Math.max(0, Math.min(100, 100 - Number(primary.used_percent))),
      used_percent: Number(primary.used_percent),
      window_minutes: primary.window_minutes ?? null,
      resets_at: primary.resets_at ?? null,
      limit_id: record?.payload?.rate_limits?.limit_id ?? "codex",
      observed_at: record.timestamp ?? null,
    }, sessionId);
    if (observation) candidates.push(observation);
  }
  return selectBestObservation(...candidates);
}

function quotaSnapshotPath() {
  return path.join(DATA_DIR, "quota-latest.json");
}

function validQuota(quota) {
  const remaining = Number(quota?.remaining_percent);
  const used = Number(quota?.used_percent);
  const windowMinutes = Number(quota?.window_minutes);
  const resetsAt = Number(quota?.resets_at);
  return quota?.limit_id === "codex"
    && Number.isFinite(remaining) && remaining >= 0 && remaining <= 100
    && Number.isFinite(used) && used >= 0 && used <= 100
    && Math.abs((remaining + used) - 100) < 0.000001
    && Number.isInteger(windowMinutes) && windowMinutes > 0
    && Number.isFinite(resetsAt) && resetsAt > 0;
}

function snapshotObservation(snapshot, options = {}) {
  if (snapshot?.schema_version !== 1 && snapshot?.schema_version !== QUOTA_SNAPSHOT_SCHEMA_VERSION) return null;
  const capturedAt = Date.parse(snapshot.captured_at);
  const now = options.now ?? Date.now();
  if (!Number.isFinite(capturedAt) || capturedAt > now || now - capturedAt > QUOTA_SNAPSHOT_MAX_AGE_MS) return null;
  return normalizeObservation(snapshot.quota, snapshot.source_session_id, { now });
}

function persistQuotaSnapshot(observation) {
  if (!observation) return;
  ensureDataDir();
  const target = quotaSnapshotPath();
  const snapshot = {
    schema_version: QUOTA_SNAPSHOT_SCHEMA_VERSION,
    captured_at: new Date().toISOString(),
    source_session_id: observation.source_session_id,
    observation_id: observation.id,
    quota: observation.quota,
  };
  withFileLock(`${target}.lock`, () => {
    let existing = null;
    try {
      existing = JSON.parse(fs.readFileSync(target, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    const existingObservation = snapshotObservation(existing);
    const comparison = existingObservation ? compareObservations(existingObservation, observation) : -1;
    if (comparison > 0 || (comparison === 0 && existing?.schema_version === QUOTA_SNAPSHOT_SCHEMA_VERSION)) return;
    writeJsonAtomic(target, snapshot);
  });
}

function readQuotaSnapshot(sessionId) {
  try {
    const snapshot = JSON.parse(fs.readFileSync(quotaSnapshotPath(), "utf8"));
    const observation = snapshotObservation(snapshot);
    if (!observation || observation.source_session_id !== sessionId) return null;
    if (snapshot.schema_version !== QUOTA_SNAPSHOT_SCHEMA_VERSION) persistQuotaSnapshot(observation);
    return observation;
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

function persistQuotaBestEffort(observation) {
  if (!observation) return;
  try { persistQuotaSnapshot(observation); } catch {}
}

function readQuotaSnapshotBestEffort(sessionId) {
  try { return readQuotaSnapshot(sessionId); } catch { return null; }
}

function isGuardApprovalTool(input) {
  if (String(input.tool_name || "").toLowerCase() !== "request_user_input") return false;
  return Array.isArray(input?.tool_input?.questions)
    && input.tool_input.questions.some((question) => question?.id === APPROVAL_ID);
}

function answerValues(input, id) {
  let response = input?.tool_response;
  if (typeof response === "string") {
    try { response = JSON.parse(response); } catch { response = {}; }
  }
  if (!response?.answers || typeof response.answers !== "object" || Array.isArray(response.answers)) return [];
  if (Object.keys(response.answers).length !== 1 || !Object.hasOwn(response.answers, id)) return [];
  const answer = response?.answers?.[id];
  if (!answer || typeof answer !== "object" || Array.isArray(answer) || Object.keys(answer).some((key) => key !== "answers")) return [];
  return Array.isArray(answer.answers) ? answer.answers.map((value) => String(value)) : [];
}

function approvalDecision(input) {
  const answers = answerValues(input, APPROVAL_ID);
  if (answers.length !== 1) return null;
  if (answers[0] === APPROVAL_ACCEPT_LABEL) return "accept";
  if (answers[0] === APPROVAL_DENY_LABEL) return "deny";
  return null;
}

function approvalToolUseId(input) {
  const value = String(input.tool_use_id ?? "").trim();
  return value || null;
}

function approvalTurnId(input) {
  const value = String(input.turn_id ?? "").trim();
  return value || null;
}

function normalizeNewlines(value) {
  return String(value ?? "").replace(/\r\n/g, "\n");
}

function canonicalApprovalQuestion(remaining, threshold, effort) {
  return {
    id: APPROVAL_ID,
    question: `Current quota remaining: "${formatPercent(remaining)}%". Stop threshold: "${Number(threshold)}%". Current reasoning effort: "${String(effort)}". Enable 使いすぎ防止モード for this run?`,
    options: APPROVAL_OPTIONS.map((option) => ({ ...option })),
  };
}

function canonicalApprovalShape(input, expected) {
  const questions = input?.tool_input?.questions;
  if (!Array.isArray(questions) || questions.length !== 1) return null;
  const question = questions[0];
  if (question?.id !== APPROVAL_ID || typeof question.question !== "string") return null;
  if (Object.keys(question).length !== 3 || !["id", "question", "options"].every((key) => Object.hasOwn(question, key))) return null;
  if (normalizeNewlines(question.question) !== normalizeNewlines(expected.question)) return null;
  if (!Array.isArray(question.options) || question.options.length !== APPROVAL_OPTIONS.length) return null;
  for (let index = 0; index < APPROVAL_OPTIONS.length; index += 1) {
    const actual = question.options[index];
    const required = APPROVAL_OPTIONS[index];
    if (!actual || typeof actual !== "object" || Array.isArray(actual)
      || Object.keys(actual).length !== 2
      || !Object.hasOwn(actual, "label")
      || !Object.hasOwn(actual, "description")) return null;
    if (actual?.label !== required.label || actual?.description !== required.description) return null;
  }
  return { ...expected, question: normalizeNewlines(expected.question) };
}

function approvalQuestionHash(shape) {
  return shape ? crypto.createHash("sha256").update(JSON.stringify(shape)).digest("hex") : null;
}

function actionablePrompt(prompt) {
  return String(prompt || "")
    .replace(/(?:^|\n)[ \t]*(?:```|~~~)[^\n]*\n[\s\S]*?(?:\n[ \t]*(?:```|~~~)[ \t]*(?=\n|$)|$)/g, "\n")
    .replace(/`[^`\r\n]*`/g, " ")
    .split(/\r?\n/)
    .filter((line) => !/^\s*>/.test(line))
    .join("\n")
    .replace(/"[^"\r\n]*"|“[^”\r\n]*”|‘[^’\r\n]*’|「[^」\r\n]*」|『[^』\r\n]*』/g, " ");
}

function requestsCapacityGuard(prompt) {
  const actionable = actionablePrompt(prompt);
  if (/\$capacity-guard/i.test(actionable)) return true;
  if (/\[@[^\]\r\n]+\]\(plugin:\/\/capacity-guard@personal\/?\)/i.test(actionable)) return true;
  if (/(?:^|\s)@capacity-guard\b/i.test(actionable)) return true;
  if (/(?:使いすぎ防止モード.{0,24}(?:実行|有効|開始|オン|使って|やって)|(?:実行|有効|開始|オン).{0,24}使いすぎ防止モード)/i.test(actionable)) return true;
  return /(?:capacity\s*guard.{0,32}(?:enable|activate|start|run|use|実行|有効|開始)|(?:enable|activate|start|run|use|実行|有効|開始).{0,32}capacity\s*guard)/i.test(actionable);
}

function requestedThreshold(prompt) {
  const actionable = actionablePrompt(prompt);
  const targeted = [
    ...actionable.matchAll(/残量\s*(-?\d+(?:\.\d+)?)\s*[%％]\s*まで/g),
    ...actionable.matchAll(/stop\s*threshold\s*(?:is|=|:)?\s*(-?\d+(?:\.\d+)?)\s*%/gi),
  ].map((match) => Number(match[1]));
  if (targeted.length === 1) {
    const value = targeted[0];
    return { valid: Number.isInteger(value) && value >= 0 && value <= 100, value };
  }
  if (targeted.length > 1) return { valid: false, value: null };
  const percentValues = [...actionable.matchAll(/(-?\d+(?:\.\d+)?)\s*[%％]/g)].map((match) => Number(match[1]));
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

function toolClass(name) {
  if (isDrainTool(name)) return "drain";
  return canonicalToolName(name) === "requestuserinput" ? "guard_approval" : "tool";
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
    trip: { reason, previous: previous ?? null, current: current ?? null, blocked_class: toolClass(toolName), ...extra },
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
  const observedQuota = latestQuota(records, input.session_id);
  if (observedQuota) persistQuotaSnapshot(observedQuota);
  const quotaObservation = selectBestObservation(observedQuota, readQuotaSnapshot(input.session_id));
  const quota = quotaObservation?.quota ?? null;
  const rawPrompt = String(input.prompt ?? "");
  const prompt = rawPrompt.trim();
  const activationRequested = requestsCapacityGuard(prompt);
  const threshold = requestedThreshold(prompt);
  const result = withState(input.session_id, (state) => {
    if (state.status === "PENDING_CONFIRMATION") {
      if (rawPrompt === "accept") {
        const expectedObservation = state.configuration_observation;
        const expectedFallbackFingerprint = fallbackFingerprint(
          state.configuration_quota?.remaining_percent,
          state.runtime?.effort,
          state.policy?.stop_threshold,
        );
        const observationMatches = quotaObservation
          && expectedObservation?.source_session_id === input.session_id
          && expectedObservation.id === quotaObservation.id
          && Number(state.configuration_quota?.remaining_percent) === Number(quota.remaining_percent)
          && state.fallback_fingerprint === expectedFallbackFingerprint;
        if (!observationMatches) {
          return { state: offState(input.session_id, "fallback_observation_changed_requires_reapproval"), action: "reapproval" };
        }
        return {
          state: {
            ...state,
            status: "ARMED",
            runtime,
            quota,
            last_observation: observationReference(quotaObservation),
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
          schema_version: STATE_SCHEMA_VERSION,
          status: "PENDING_APPROVAL",
          session_id: input.session_id,
          policy: { stop_threshold: threshold.value, stop_on_reset: true },
          runtime,
          configuration_quota: quota,
          configuration_observation: observationReference(quotaObservation),
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
    const expectedApproval = canonicalApprovalQuestion(quota.remaining_percent, threshold.value, runtime.effort);
    emit(context("UserPromptSubmit", `${baseContext} Activation request verified from the user prompt. Ask exactly one request_user_input question using this canonical shape and no other question or text: ${JSON.stringify(expectedApproval)}. Do not start task work first.`));
  } else if (result.action === "invalid") {
    emit(context("UserPromptSubmit", `${baseContext} Capacity Guard remains OFF: specify zero or one whole-number percentage from 0% through 100%.`));
  } else if (result.action === "unavailable") {
    emit(context("UserPromptSubmit", `${baseContext} Capacity Guard remains OFF because the current quota value is unavailable and cannot be confirmed before activation.`));
  } else if (result.action === "reapproval") {
    emit(context("UserPromptSubmit", `${baseContext} Capacity Guard remains OFF because the displayed quota observation changed before fallback acceptance. Request activation again and approve the newly displayed values.`));
  } else emit(context("UserPromptSubmit", baseContext));
}

function handleApprovalPre(input, records) {
  const runtime = currentRuntime(records, input.turn_id, input.model);
  const toolUseId = approvalToolUseId(input);
  const turnId = approvalTurnId(input);
  if (!toolUseId) return emit(deny("Capacity Guard approval requires a tool_use_id and cannot be enabled without one."));
  if (!turnId) return emit(deny("Capacity Guard approval requires a turn_id and cannot be enabled without one."));
  if (!Array.isArray(input?.tool_input?.questions)
    || input.tool_input.questions.length !== 1
    || input.tool_input.questions[0]?.id !== APPROVAL_ID) {
    return emit(deny("Capacity Guard approval requires exactly one capacity_guard_approval question."));
  }
  const observedQuota = latestQuota(records, input.session_id);
  persistQuotaBestEffort(observedQuota);
  const currentObservation = selectBestObservation(observedQuota, readQuotaSnapshotBestEffort(input.session_id));
  const currentQuota = currentObservation?.quota ?? null;
  const result = withState(input.session_id, (state) => {
    if (state.status === "TRIPPED") return { action: "tripped" };
    if (state.status !== "PENDING_APPROVAL") return { action: "not_configured" };
    if (!currentQuota) return { state: offState(input.session_id, "quota_unavailable_before_approval"), action: "unavailable" };
    const threshold = Number(state.policy?.stop_threshold);
    const expectedQuestion = canonicalApprovalQuestion(currentQuota.remaining_percent, threshold, runtime.effort);
    const verifiedShape = canonicalApprovalShape(input, expectedQuestion);
    if (!verifiedShape) return { action: "mismatch", expectedQuestion };
    return {
      state: {
        ...state,
        approval_probe: {
          turn_id: turnId,
          tool_use_id: toolUseId,
          question_hash: approvalQuestionHash(verifiedShape),
          runtime,
          displayed_quota: currentQuota,
          displayed_observation: observationReference(currentObservation),
          question_verified: true,
        },
      },
      action: "verified",
    };
  });

  if (result.action === "tripped") emit(deny("Capacity Guard is TRIPPED. Start a new user turn before configuring another guarded run."));
  else if (result.action === "not_configured") emit(deny("Configure capacity_guard_threshold before requesting approval."));
  else if (result.action === "unavailable") emit(deny("The current quota value is unavailable, so Capacity Guard cannot be enabled."));
  else if (result.action === "mismatch") emit(deny(`Approval must use the canonical capacity_guard_approval question and options exactly: ${result.expectedQuestion.question}`));
  else emit({});
}

function handleApprovalPost(input) {
  if (!isGuardApprovalTool(input)) return emit({});
  const decision = approvalDecision(input);
  const toolUseId = approvalToolUseId(input);
  const turnId = approvalTurnId(input);
  const records = readTranscriptRecords(input.transcript_path);
  const observedQuota = latestQuota(records, input.session_id);
  if (observedQuota) persistQuotaSnapshot(observedQuota);
  const currentObservation = selectBestObservation(observedQuota, readQuotaSnapshot(input.session_id));
  const result = withState(input.session_id, (state) => {
    const probe = state.approval_probe;
    const expectedQuestion = canonicalApprovalQuestion(
      probe?.displayed_quota?.remaining_percent,
      state.policy?.stop_threshold,
      probe?.runtime?.effort,
    );
    const verifiedShape = canonicalApprovalShape(input, expectedQuestion);
    const displayedIdentity = probe?.displayed_quota && probe?.displayed_observation
      ? observationIdentity(probe.displayed_quota, input.session_id)
      : null;
    const verified = state.status === "PENDING_APPROVAL"
      && probe?.question_verified
      && toolUseId !== null
      && turnId !== null
      && probe.tool_use_id === toolUseId
      && probe.turn_id === turnId
      && verifiedShape !== null
      && probe.question_hash === approvalQuestionHash(verifiedShape)
      && probe.displayed_observation?.source_session_id === input.session_id
      && probe.displayed_observation?.id === displayedIdentity
      && currentObservation?.id === probe.displayed_observation?.id;
    if (!verified) return { action: "unverified" };
    if (decision === null) return { action: "invalid_response" };
    if (decision === "deny") return { state: offState(input.session_id, "approval_denied"), action: "off" };
    return {
      state: {
        status: "ARMED",
        schema_version: STATE_SCHEMA_VERSION,
        session_id: input.session_id,
        policy: state.policy,
        runtime: probe.runtime,
        quota: probe.displayed_quota,
        last_observation: probe.displayed_observation,
        missing_checkpoints: 0,
        armed_via: "request_user_input",
      },
      action: "armed",
    };
  });

  if (result.action === "armed") {
    appendAudit({ event: "armed", session_id: input.session_id, via: "request_user_input", policy: result.state.policy, runtime: result.state.runtime, quota: result.state.quota });
    emit(context("PostToolUse", `Capacity Guard: ARMED. Current quota remaining: ${formatPercent(result.state.quota.remaining_percent)}%. Stop threshold: ${result.state.policy.stop_threshold}%. Observed effort: ${result.state.runtime.effort}. Reset policy: stop.`));
  } else if (result.action === "unverified" || result.action === "invalid_response") {
    emit(context("PostToolUse", "Capacity Guard was not armed because this approval response identity was not verified. A separately verified pending approval, if any, remains pending."));
  } else {
    emit(context("PostToolUse", "Capacity Guard was denied and remains OFF."));
  }
}

function handlePreTool(input) {
  const records = readTranscriptRecords(input.transcript_path);
  if (isGuardApprovalTool(input)) return handleApprovalPre(input, records);
  const observedQuota = latestQuota(records, input.session_id);
  persistQuotaBestEffort(observedQuota);
  const currentObservation = selectBestObservation(observedQuota, readQuotaSnapshotBestEffort(input.session_id));

  const result = withState(input.session_id, (state) => {
    if (state.status === "TRIPPED") return { action: isDrainTool(input.tool_name) ? "allow_drain" : "deny_tripped" };
    if (state.status !== "ARMED") return { action: "allow_off" };

    const runtime = currentRuntime(records, input.turn_id, input.model);
    const previousObservation = normalizeObservation(state.quota, input.session_id, { allowStale: true, allowExpiredReset: true });
    const previous = previousObservation?.quota ?? state.quota ?? null;
    const hasNewObservation = currentObservation
      && (!previousObservation || compareObservations(currentObservation, previousObservation) > 0)
      && currentObservation.id !== state.last_observation?.id;
    const current = hasNewObservation ? currentObservation.quota : previous;
    const next = hasNewObservation ? {
      ...state,
      runtime,
      quota: current,
      last_observation: observationReference(currentObservation),
      missing_checkpoints: 0,
    } : {
      ...state,
      runtime,
      missing_checkpoints: Number(state.missing_checkpoints || 0) + 1,
    };

    if (hasNewObservation && previous && sameWindow(previous, current)
      && Number(previous.remaining_percent) < 100
      && Number(current.remaining_percent) === 100
      && state.policy?.stop_on_reset !== false) {
      return { state: tripState(next, "RESET_DETECTED", previous, current, input.tool_name), action: "trip" };
    }
    if (current && Number.isFinite(Number(state.policy?.stop_threshold))
      && Number(current.remaining_percent) <= Number(state.policy.stop_threshold)) {
      return { state: tripState(next, "THRESHOLD_REACHED", previous, current, input.tool_name), action: "trip" };
    }
    if (!hasNewObservation) {
      if (next.missing_checkpoints >= 2) {
        return { state: tripState(next, "OBSERVATION_UNAVAILABLE", previous, null, input.tool_name, { missing_checkpoints: next.missing_checkpoints }), action: "trip" };
      }
      return { state: next, action: "allow_bootstrap" };
    }
    return { state: next, action: "allow" };
  });

  if (result.action === "trip") {
    appendAudit({ event: "tripped", session_id: input.session_id, ...result.state.trip, policy: result.state.policy });
    emit(deny(`Capacity Guard TRIPPED: ${result.state.trip.reason}. This tool was not started. Allow already-started indivisible operations to converge, then report current location, completed scope, and next task before ending the turn. resets_at is auxiliary evidence only; do not infer a reset cause.`));
  } else if (result.action === "deny_tripped") {
    emit(deny("Capacity Guard is TRIPPED. New tools, spawns, follow-ups, waves, and next tasks are blocked. Only list_agents and wait_agent are allowed for minimal drain."));
  } else if (result.action === "allow_bootstrap") {
    emit(context("PreToolUse", "Capacity Guard has no new quota observation at this checkpoint. One indivisible tool is allowed; a second consecutive checkpoint without a new observation will trip OBSERVATION_UNAVAILABLE."));
  } else emit({});
}

function canonicalFallbackBlock(remaining, effort, threshold) {
  return [
    `Current quota remaining: "${formatPercent(remaining)}%".`,
    `Current reasoning effort: "${String(effort)}".`,
    `Capacity Guard policy: stop_threshold=${Number(threshold)}%, reset=stop.`,
    FALLBACK_ACCEPT,
  ].join("\n");
}

function fallbackFingerprint(remaining, effort, threshold) {
  return crypto.createHash("sha256")
    .update(normalizeNewlines(canonicalFallbackBlock(remaining, effort, threshold)))
    .digest("hex");
}

function handleStop(input, isSubagent) {
  const message = String(input.last_assistant_message || "");
  const result = withState(input.session_id, (state) => {
    if (state.status === "TRIPPED") return { action: "stop" };
    if (isSubagent) return { action: "continue" };
    const configuredIdentity = state.configuration_quota && state.configuration_observation
      ? observationIdentity(state.configuration_quota, input.session_id)
      : null;
    const expectedFallback = canonicalFallbackBlock(
      state.configuration_quota?.remaining_percent,
      state.runtime?.effort,
      state.policy?.stop_threshold,
    );
    const fallbackMatches = state.status === "PENDING_APPROVAL"
      && normalizeNewlines(message) === normalizeNewlines(expectedFallback)
      && state.configuration_observation?.source_session_id === input.session_id
      && state.configuration_observation?.id === configuredIdentity;
    if (fallbackMatches) {
      return {
        state: {
          status: "PENDING_CONFIRMATION",
          session_id: input.session_id,
          policy: state.policy,
          runtime: state.runtime,
          configuration_quota: state.configuration_quota,
          configuration_observation: state.configuration_observation,
          fallback_fingerprint: fallbackFingerprint(
            state.configuration_quota.remaining_percent,
            state.runtime.effort,
            state.policy.stop_threshold,
          ),
          reason: "awaiting_accept",
        },
        action: "pending",
      };
    }
    const fallbackAttempt = message.includes(FALLBACK_ACCEPT)
      || message.includes("Current quota remaining:")
      || message.includes("Capacity Guard policy:");
    if (state.status === "PENDING_APPROVAL" && fallbackAttempt) {
      return { state: offState(input.session_id, "fallback_display_not_bound"), action: "continue" };
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

function main() {
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
}

const directEntry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (directEntry === import.meta.url) main();
