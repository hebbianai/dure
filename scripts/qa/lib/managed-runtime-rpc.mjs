import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";

// The surrounding native/app QA guardian owns detached Hosts. This helper
// only transports one bounded request to its explicitly selected runtime.
export async function managedRuntimeOperation({ runtime, cwd, environment }, name, request) {
  const body = Buffer.from(JSON.stringify(request));
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(body.length);
  const child = spawn(runtime, ["--no-autostart", `internal-hmux-managed-${name}`],
    { env: environment, cwd, stdio: ["pipe", "pipe", "pipe"], timeout: 10000 });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", bytes => stdout.push(bytes));
  child.stderr.on("data", bytes => stderr.push(bytes));
  child.stdin.end(Buffer.concat([prefix, body]));
  const [code] = await once(child, "close");
  assert.equal(code, 0, Buffer.concat(stderr).toString());
  const output = Buffer.concat(stdout);
  assert.equal(output.readUInt32BE(), output.length - 4);
  return JSON.parse(output.subarray(4));
}
