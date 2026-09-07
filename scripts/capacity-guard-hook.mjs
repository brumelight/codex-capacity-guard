#!/usr/bin/env node

// Legacy entrypoint for a previously loaded hook registration.
// Prompt-first Capacity Guard registers no hooks. Do not read stdin, quota,
// transcript, environment state, or filesystem; OFF must not affect tool use.
process.stdout.write("{}\n");
