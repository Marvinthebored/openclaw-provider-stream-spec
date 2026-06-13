#!/usr/bin/env node
// Captures the codex app-server JSON-RPC envelope exactly as openclaw consumes it
// (extensions/codex/src/app-server/client.ts handshake; experimentalRawEvents: true).
// Usage: node capture-codex-appserver.mjs <outfile-prefix> "<prompt>"
// Writes <prefix>.jsonl   — every stdout line from the server, verbatim (the golden)
//        <prefix>.sent.jsonl — frames we sent (for reference, not part of the golden)
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { createInterface } from "node:readline";

const [prefix, prompt] = process.argv.slice(2);
if (!prefix || !prompt) {
  console.error("usage: capture-codex-appserver.mjs <prefix> <prompt>");
  process.exit(2);
}

const golden = createWriteStream(`${prefix}.jsonl`);
const sentLog = createWriteStream(`${prefix}.sent.jsonl`);
const child = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "pipe"] });
child.stderr.on("data", (d) => process.stderr.write(d));

let nextId = 1;
const pending = new Map();
function request(method, params) {
  const id = nextId++;
  const frame = { jsonrpc: "2.0", id, method, params };
  const line = JSON.stringify(frame);
  sentLog.write(line + "\n");
  child.stdin.write(line + "\n");
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
function notify(method, params) {
  const frame = params === undefined
    ? { jsonrpc: "2.0", method }
    : { jsonrpc: "2.0", method, params };
  const line = JSON.stringify(frame);
  sentLog.write(line + "\n");
  child.stdin.write(line + "\n");
}

const done = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("timeout (240s)")), 240_000);
  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    golden.write(line + "\n");
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve: res, reject: rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      return;
    }
    // server-initiated requests (approvals) — auto-decline; read-only turn should not need them
    if (msg.id !== undefined && msg.method) {
      const reply = { jsonrpc: "2.0", id: msg.id, result: { decision: "denied" } };
      sentLog.write(JSON.stringify(reply) + "\n");
      child.stdin.write(JSON.stringify(reply) + "\n");
      return;
    }
    if (msg.method === "turn/completed" || msg.method === "error") {
      clearTimeout(timer);
      resolve(msg.method);
    }
  });
  child.on("exit", (code) => reject(new Error(`server exited early (${code})`)));
});

try {
  await request("initialize", {
    clientInfo: { name: "openclaw", title: "OpenClaw", version: "capture" },
    capabilities: { experimentalApi: true },
  });
  notify("initialized");
  const { thread } = await request("thread/start", {
    cwd: "/tmp/codex-capture",
    sandbox: "read-only",
    approvalPolicy: "never",
    experimentalRawEvents: true,
  });
  await request("turn/start", {
    threadId: thread.id,
    input: [{ type: "text", text: prompt }],
  });
  const how = await done;
  console.error(`turn finished via ${how}`);
} finally {
  child.kill();
  golden.end();
  sentLog.end();
}
