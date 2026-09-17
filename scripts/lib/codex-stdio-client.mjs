import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

// Configuration belongs to Codex. No TOML rewriting, MCP hot reload, or thread
// is necessary to update the user layer for subsequent provider launches.
export async function openCodexClient({ executable, cwd, env }) {
  const child = spawn(executable, ["app-server"], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  let sequence = 0;
  let ended = false;
  const failPending = (error) => {
    for (const request of pending.values()) request.reject(error);
  };
  child.stderr.resume();
  child.stdin.on("error", failPending);
  const exited = new Promise((resolve) => {
    child.once("error", (error) => { failPending(error); ended = true; resolve({ error }); });
    child.once("exit", (code, signal) => {
      ended = true;
      failPending(new Error(`Codex app-server exited (${code}/${signal})`));
      resolve({ code, signal });
    });
  });
  createInterface({ input: child.stdout }).on("line", (line) => {
    try {
      const message = JSON.parse(line);
      if (message.method && message.id !== undefined) {
        child.stdin.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: "Interactive requests are not supported by this operator." } })}\n`);
      } else if (message.id !== undefined) {
        const request = pending.get(message.id);
        if (message.error) request?.reject(new Error(message.error.message));
        else request?.resolve(message.result);
      }
    } catch (error) { failPending(error); }
  });
  const client = {
    pid: child.pid,
    call(method, params) {
      if (ended) return Promise.reject(new Error("Codex app-server is closed"));
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const finish = (callback) => (value) => { clearTimeout(timer); pending.delete(id); callback(value); };
        const timer = setTimeout(() => pending.get(id)?.reject(new Error(`Codex ${method} timed out; do not retry a write without reading its outcome`)), 30_000);
        pending.set(id, { resolve: finish(resolve), reject: finish(reject) });
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      });
    },
    async close() {
      child.stdin.end();
      const result = await exited;
      if (result.error) throw result.error;
      if (result.code !== 0) throw new Error(`Codex app-server exited (${result.code}/${result.signal})`);
    },
  };
  try {
    await client.call("initialize", {
      clientInfo: { name: "dure_memory_integration", version: "1" },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    return client;
  } catch (error) {
    child.stdin.end();
    throw error;
  }
}
