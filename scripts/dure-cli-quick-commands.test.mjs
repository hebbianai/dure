import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { dispatchCliSettingsRequest } from "../src/lib/cli/cliSettingsCommands.ts";
import { DEFAULT_UI_PREFS } from "../src/lib/settings/uiPrefs.ts";

const cli = fileURLToPath(new URL("../cli/dure.mjs", import.meta.url));
const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(capabilities = ["quick_commands_v1"]) {
  const root = mkdtempSync(join(tmpdir(), "dure-quick-commands-cli-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const requests = [];
  let prefs = { ...DEFAULT_UI_PREFS, quickCommands: [
    { id: "existing", label: "Existing", text: "Keep me", appendEnter: true },
  ] };
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ path: request.url, authorization: request.headers.authorization, body: JSON.parse(body) });
    await dispatchCliSettingsRequest({ reqId: `request-${requests.length}`, action: "quick-commands", params: requests.at(-1).body }, {
      claim: async () => true,
      getPrefs: () => prefs,
      setPrefs: (patch) => { prefs = { ...prefs, ...patch }; },
      complete: async (_reqId, result) => {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(result));
      },
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  mkdirSync(join(root, ".dure"));
  writeFileSync(join(root, ".dure/server.json"), JSON.stringify({
    port: server.address().port, token: "fixture-control-token", capabilities,
  }));
  const env = { ...process.env, HOME: root, DURE_HOME: join(root, ".dure"),
    DURE_APP_CHANNEL: "stable", HEBBIAN_APP_CHANNEL: "stable",
    HMUX_DISCOVERY_ROOT: join(root, "hmux-discovery") };
  const run = (args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "quick-commands", ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  return { root, requests, run };
}

describe("Quick Commands CLI", () => {
  it("saves exact multiline text through app settings without submitting pane input", async () => {
    const { root, run, requests } = await fixture();
    const text = "분석하고 개선해줘.\n  Preserve whitespace, $HOME and `literal`.\n";
    const file = join(root, "architecture.txt");
    writeFileSync(file, text);
    const result = await run(["put", "architecture-review", "--label", "Architecture review", "--file", file, "--json"]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout).command).toEqual({ id: "architecture-review", label: "Architecture review", text, appendEnter: false });
    expect(requests).toEqual([{ path: "/quick-commands", authorization: "Bearer fixture-control-token",
      body: { operation: "put", command: { id: "architecture-review", label: "Architecture review", text, appendEnter: false } } }]);
  });

  it("lists and removes exact saved IDs and makes Enter explicit", async () => {
    const { run, requests } = await fixture();
    expect((await run(["list", "--json"])).code).toBe(0);
    expect((await run(["put", "review", "--label", "Review", "--text", "Review safely", "--append-enter"])).code).toBe(0);
    expect((await run(["remove", "review", "--json"])).code).toBe(0);
    expect(requests.map((request) => request.body)).toEqual([
      { operation: "list" },
      { operation: "put", command: { id: "review", label: "Review", text: "Review safely", appendEnter: true } },
      { operation: "remove", id: "review" },
    ]);
  });

  it("rejects ambiguous text sources without contacting the app", async () => {
    const { run, requests } = await fixture();
    expect((await run(["put", "review", "--label", "Review", "--text", "hello", "--file", "missing"])).code).not.toBe(0);
    expect(requests).toEqual([]);
  });

  it("updates the same ID without duplicating it or losing another saved command", async () => {
    const { run } = await fixture();
    for (const text of ["First", "Revised"]) {
      expect((await run(["put", "review", "--label", "Review", "--text", text])).code).toBe(0);
    }
    const listed = JSON.parse((await run(["list", "--json"])).stdout);
    expect(listed.commands).toEqual([
      { id: "existing", label: "Existing", text: "Keep me", appendEnter: true },
      { id: "review", label: "Review", text: "Revised", appendEnter: false },
    ]);
    expect((await run(["remove", "review"])).code).toBe(0);
    expect(JSON.parse((await run(["list", "--json"])).stdout).commands).toEqual([listed.commands[0]]);
  });

  it("does not report a rejected command as saved", async () => {
    const { run } = await fixture();
    const result = await run(["put", "review", "--label", "Review", "--text", "\u001b[200~"]);
    expect(result.code).not.toBe(0);
    expect(JSON.parse((await run(["list", "--json"])).stdout).commands).toHaveLength(1);
  });

  it("explains an older app instead of touching a private settings file", async () => {
    const { run, requests } = await fixture([]);
    const result = await run(["list", "--json"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("update");
    expect(requests).toEqual([]);
  });

  it("provides help without an app and refuses writes when it is absent", async () => {
    const { root, run, requests } = await fixture();
    unlinkSync(join(root, ".dure/server.json"));
    expect((await run(["--help"])).code).toBe(0);
    const result = await run(["put", "review", "--label", "Review", "--text", "Review safely"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("not running");
    expect(requests).toEqual([]);
  });
});
