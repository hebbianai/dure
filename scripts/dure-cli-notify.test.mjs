import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const cli = fileURLToPath(new URL("../cli/dure.mjs", import.meta.url));
const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const DELIVERED = {
  ok: true,
  status: "delivered",
  agent: { id: "agent-a", name: "Codex", project: "Workspace" },
  desktop: { status: "shown" },
  phone: { status: "not_sent", reason: "unsupported" },
};

/** A loopback app that answers /agent/notify with `answer`'s receipt. */
async function fixture({ capabilities = ["agent.notify_v1"], answer = () => [200, DELIVERED] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "dure-notify-cli-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ path: request.url, authorization: request.headers.authorization, body: JSON.parse(body) });
    const [status, payload] = answer(requests.at(-1).body);
    response.statusCode = status;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(payload));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  mkdirSync(join(root, ".dure"));
  writeFileSync(join(root, ".dure/server.json"), JSON.stringify({
    port: server.address().port, token: "fixture-control-token", capabilities,
  }));
  const baseEnvironment = { ...process.env, HOME: root, DURE_HOME: join(root, ".dure"),
    DURE_APP_CHANNEL: "stable", HEBBIAN_APP_CHANNEL: "stable",
    HMUX_DISCOVERY_ROOT: join(root, "hmux-discovery") };
  // The test itself may run inside a Dure pane; each run names its own Session.
  delete baseEnvironment.HMUX_SESSION_ID;
  const run = (args, environment = {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "notify", ...args], {
      env: { ...baseEnvironment, ...environment }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  return { root, requests, run };
}

describe("dure notify", () => {
  it("joins the words, names this pane's Session and prints what each surface did", async () => {
    const { run, requests } = await fixture();
    const result = await run(["  Build", "is", "green  "], { HMUX_SESSION_ID: "managed_0123abcd" });
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toBe("Delivered from Codex · Workspace: desktop shown, phone not sent (unsupported).\n");
    expect(requests).toEqual([{ path: "/agent/notify", authorization: "Bearer fixture-control-token",
      body: { message: "Build is green", sessionId: "managed_0123abcd" } }]);
  });

  it("sends no Session outside a pane and keeps line breaks and 280 code points", async () => {
    const { run, requests } = await fixture();
    const wide = "😀".repeat(280);
    expect((await run([wide])).code).toBe(0);
    expect((await run(["line one\nline two"])).code).toBe(0);
    expect((await run(["--", "-1 failing test"])).code).toBe(0);
    expect(requests.map((request) => request.body)).toEqual([
      { message: wide }, { message: "line one\nline two" }, { message: "-1 failing test" },
    ]);
  });

  it("prints the receipt with --json and exits 1 when nothing was shown", async () => {
    const disabled = { ...DELIVERED, status: "not_delivered", desktop: { status: "disabled" } };
    const limited = { ...DELIVERED, status: "rate_limited", retryAfterMs: 19_500,
      desktop: { status: "not_sent", reason: "rate_limited" }, phone: { status: "not_sent", reason: "rate_limited" } };
    const answers = [disabled, limited];
    const { run } = await fixture({ answer: () => [200, answers.shift()] });
    const off = await run(["Hi", "--json"]);
    expect(off.code).toBe(1);
    expect(JSON.parse(off.stdout)).toEqual(disabled);
    const rateLimited = await run(["Hi"]);
    expect(rateLimited.code).toBe(1);
    expect(rateLimited.stdout).toBe("Rate limited; nothing was shown. Try again in 20 s.\n");
  });

  it.each([
    [[], "notify_usage"],
    [["   "], "notify_message_invalid"],
    [["x".repeat(281)], "notify_message_invalid"],
    [["a\tb"], "notify_message_invalid"],
    [["a\u001b[31mb"], "notify_message_invalid"],
    [["rm -rf‮gpj.exe"], "notify_message_invalid"],
    [["zero​width"], "notify_message_invalid"],
    [["--unknown", "Hi"], null],
  ])("refuses %j as a usage error without contacting the app", async (args, code) => {
    const { run, requests } = await fixture();
    const result = await run([...args, ...(code ? ["--json"] : [])]);
    expect(result.code).toBe(2);
    if (code) expect(JSON.parse(result.stderr).error.code).toBe(code);
    expect(requests).toEqual([]);
  });

  it("treats the app's own refusal of the text as a usage error", async () => {
    const { run } = await fixture({ answer: () => [409, { ok: false,
      error: { code: "notify_message_invalid", reason: "too_long", message: "The message is longer than 280 characters." } }] });
    const result = await run(["Hi"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("longer than 280");
  });

  it("asks for an update instead of sending to an app without the capability", async () => {
    const { run, requests } = await fixture({ capabilities: ["quick_commands_v1"] });
    const result = await run(["Hi"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Please update the running Dure app");
    expect(requests).toEqual([]);
  });

  it("provides help without an app and reports a missing app clearly", async () => {
    const { root, run, requests } = await fixture();
    unlinkSync(join(root, ".dure/server.json"));
    const help = await run(["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("dure notify <message...>");
    const result = await run(["Hi", "--json"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr).error).toMatchObject({ code: "client_unavailable" });
    expect(JSON.parse(result.stderr).error.message).toContain("No running Dure app");
    expect(requests).toEqual([]);
  });
});
