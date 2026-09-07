#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hook = path.join(root, "scripts", "capacity-guard-hook.mjs");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "capacity-guard-prompt-test-"));
const config = JSON.parse(fs.readFileSync(path.join(root, "hooks", "hooks.json"), "utf8"));
assert.deepEqual(config, { hooks: {} }, "No quota hooks are registered");
const manifest = JSON.parse(fs.readFileSync(path.join(root, ".codex-plugin", "plugin.json"), "utf8"));
assert.deepEqual(manifest.interface.capabilities, ["skills"]);

let count = 0;
for (const status of ["OFF", "ARMED", "TRIPPED", "PENDING_APPROVAL", "corrupt"]) {
  const data = path.join(scratch, status);
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, "session.json"), status === "corrupt" ? "{" : JSON.stringify({
    schema_version: 2, status, session_id: "session", policy: { stop_threshold: 30 },
    quota: { remaining_percent: 20, observed_at: "2000-01-01T00:00:00Z" }
  }));
  // A contended lock and unwritable audit destination reproduced legacy OFF failures.
  fs.mkdirSync(path.join(data, "session.json.lock"));
  fs.mkdirSync(path.join(data, "events.jsonl"));
  fs.writeFileSync(path.join(data, "quota-latest.json"), "{");
  const before = fs.readFileSync(path.join(data, "session.json"));
  for (const event of ["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SubagentStop", "SessionEnd"]) {
    const result = spawnSync(process.execPath, [hook], {
      input: JSON.stringify({ hook_event_name: event, session_id: "session", tool_name: "exec_command", prompt: "Review capacity guard" }),
      encoding: "utf8", timeout: 5000,
      env: { ...process.env, CAPACITY_GUARD_DATA_DIR: data, PLUGIN_DATA: data },
    });
    assert.equal(result.status, 0, `${status}/${event}: ${result.stderr}`);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {});
    count++;
  }
  assert.deepEqual(fs.readFileSync(path.join(data, "session.json")), before, "Historical state remains untouched");
  assert.deepEqual(fs.readdirSync(data).sort(), ["events.jsonl", "quota-latest.json", "session.json", "session.json.lock"]);
}
for (const input of ["{", "", JSON.stringify({session_id:"another-session", parent_session_id:"session", hook_event_name:"PreToolUse"})]) {
  const result = spawnSync(process.execPath, [hook], {input, encoding:"utf8", timeout:5000,
    env:{...process.env,CAPACITY_GUARD_DATA_DIR:path.join(scratch,"missing","data")}});
  assert.equal(result.status,0);
  assert.deepEqual(JSON.parse(result.stdout),{});
  count++;
}
assert.equal(fs.existsSync(path.join(scratch,"missing")),false);
console.log(`capacity-guard tests: PASS (${count} legacy invocation cases; no hook registration)`);
console.log("Prompt behavior and actual agent convergence are not proven by these tests.");
