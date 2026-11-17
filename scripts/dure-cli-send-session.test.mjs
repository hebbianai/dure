import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hmuxSession, runSessionCli, writeRegistry } from "./lib/dure-session-test-fixture.mjs";

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
// `shows` answers the first Session lookups in order; null fails the lookup
// the way Hmux does when it cannot read discovery or exits non-zero. Later
// lookups answer `session`.
function fixture(session = hmuxSession(), input = {}, { delayMs = 0, exitCode = 0, shows = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "dure-send-session-"));
  roots.push(root);
  const calls = join(root, "calls.jsonl");
  writeFileSync(calls, "");
  const hmux = join(root, "hmux.mjs");
  writeFileSync(hmux, `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
if (args.includes('capabilities')) console.log(JSON.stringify({schemaVersion:2,capabilities:['semantic_command_input_v1','semantic_key_input_v1','draft_guarded_command_input_v1']}));
else if (args.includes('show')) {
  const shows = ${JSON.stringify(shows)};
  const seen = readFileSync(${JSON.stringify(calls)}, 'utf8').trim().split('\\n').filter(line => JSON.parse(line).includes('show')).length;
  const answer = seen <= shows.length ? shows[seen - 1] : ${JSON.stringify(session)};
  if (answer === null) {
    console.error('hmux: error: local discovery read exceeded its wall-clock budget');
    process.exit(1);
  }
  console.log(JSON.stringify(answer));
}
else if (args.includes('command-input')) {
  if (args.includes('--key')) {
    console.log(JSON.stringify({schemaVersion:1,ok:true,sessionId:'session-1',workspaceId:'workspace-1',receipt:{terminalEpoch:'terminal-1',keys:args.filter(a=>a==='--key').map((_,i)=>({recordId:String(i+1),state:'written_to_pty'}))}}));
    process.exit(0);
  }
  if (${delayMs}) await new Promise(resolve => setTimeout(resolve, ${delayMs}));
  process.exitCode = ${exitCode};
  const atomic = args.includes('--draft-guard-wait-ms');
  console.log(JSON.stringify({ok:true,receipt:{terminalEpoch:'terminal-1',text:{recordId:'1',state:'written_to_pty'},submit:args.includes('--submit')?{recordId:atomic?'1':'2',state:'written_to_pty'}:null,...(atomic?{atomic:true}:{})},...${JSON.stringify(input)}}));
} else process.exit(72);
`);
  chmodSync(hmux, 0o700);
  return { root, hmux, calls: () => readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) };
}

describe("exact managed Session send without a client registry", () => {
  it("explicit Session/workspace keys ignore a conflicting client display name", () => {
    const f = fixture();
    writeRegistry(f.root, [{id:"other-agent", name:"session-1", sessionId:"session-2", project:"other"}]);
    const result = runSessionCli(f.root, f.hmux, ["send-keys","session-1","Down","--workspace","workspace-1","--json"]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).target).toEqual({sessionId:"session-1",workspaceId:"workspace-1"});
    expect(f.calls().filter(args=>args.includes("command-input"))).toHaveLength(1);
  });

  it("does not fall back to local input when a backend profile is selected", () => {
    const f = fixture();
    const result = runSessionCli(f.root, f.hmux, ["send-keys","session-1","Enter","--json"], {DURE_BACKEND_PROFILE:"remote"});
    expect(result.status).not.toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ok:false,error:{deliveryState:"not_written"}});
    expect(f.calls()).toEqual([]);
  });

  it.each([[], ["--workspace", "workspace-1"]])("sends semantic keys to a headless run without opening a pane: %j", (...scope) => {
    const f = fixture();
    const result = runSessionCli(f.root, f.hmux, ["send-keys", "session-1", "Down", "Enter", ...scope, "--json"]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).target).toEqual({sessionId:"session-1", workspaceId:"workspace-1"});
    const writes = f.calls().filter(args => args.includes("command-input"));
    expect(writes).toHaveLength(1);
    expect(writes[0].slice(-4)).toEqual(["--key", "Down", "--key", "Enter"]);
    expect(JSON.parse(writes[0][writes[0].indexOf("--expected-fence-json") + 1])).toMatchObject({session_id:"session-1",workspace_id:"workspace-1",terminal_epoch:"terminal-1",channel_epoch:"7"});
  });

  it.each([
    {session_id:"replacement"}, {workspace_id:"wrong"}, {health:"unprobed"},
    {health:"exited",effectiveLifecycle:"exited"}, {session_class:"standalone"}, {terminal_epoch:""},
  ])("refuses keys when exact headless authority is unavailable: %j", patch => {
    const f=fixture(hmuxSession(1,patch));
    const result=runSessionCli(f.root,f.hmux,["send-keys","session-1","Down","--workspace","workspace-1","--json"]);
    expect(result.status).not.toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ok:false,error:{deliveryState:"not_written"}});
    expect(f.calls().some(args=>args.includes("command-input"))).toBe(false);
  });

  it("allows the native ten-second deadline to report an uncertain outcome before the process watchdog", () => {
    const f = fixture(hmuxSession(), { ok: false, error: { code: "hmux_terminal_input_outcome_unknown", message: "Native receipt deadline elapsed", deliveryState: "unknown" } }, { delayMs: 10_100, exitCode: 1 });
    const result = runSessionCli(f.root, f.hmux, ["send", "session-1", "hello"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("hmux_terminal_input_outcome_unknown");
    expect(result.stderr).not.toContain("spawnSync");
    expect(result.stderr).toContain("deliveryState=unknown");
    expect(f.calls().filter((args) => args.includes("command-input"))).toHaveLength(1);
  });

  it("reports a process watchdog as uncertain delivery without retrying", () => {
    const f = fixture(hmuxSession(), {}, { delayMs: 16_000 });
    // A zero draft wait keeps the fifteen-second native input watchdog.
    const result = runSessionCli(f.root, f.hmux, ["send", "session-1", "hello", "--draft-wait", "0"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("hmux_command_input_process_timeout");
    expect(result.stderr).toContain("stage=process_watchdog");
    expect(result.stderr).toContain("deliveryState=outcome_unknown");
    expect(result.stderr).toContain("dure inspect");
    expect(f.calls().filter((args) => args.includes("command-input"))).toHaveLength(1);
  });
  it("guards an exact Session against the user's unsubmitted draft", () => {
    const f = fixture();
    const result = runSessionCli(f.root, f.hmux, ["send", "session-1", "hello", "--draft-wait", "4", "--json"]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).receipt).toMatchObject({atomic:true,text:{recordId:"1"},submit:{recordId:"1"}});
    const writes = f.calls().filter((args) => args.includes("command-input"));
    expect(writes).toHaveLength(1);
    expect(writes[0][writes[0].indexOf("--draft-guard-wait-ms") + 1]).toBe("4000");
  });
  it.each([[], ["--workspace", "workspace-1"]])("looks up the live generation and sends once: %j", (...scope) => {
    const f = fixture();
    const result = runSessionCli(f.root, f.hmux, ["send", "session-1", "hello", ...scope, "--json"]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).target).toEqual({ sessionId: "session-1", workspaceId: "workspace-1" });
    const writes = f.calls().filter((args) => args.includes("command-input"));
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0][writes[0].indexOf("--expected-fence-json") + 1])).toMatchObject({session_id:"session-1",workspace_id:"workspace-1",terminal_epoch:"terminal-1",channel_epoch:"7"});
  });
  it.each([
    { session_id: "different" }, { workspace_id: "different" },
    { health: "unprobed" }, { health: "exited", effectiveLifecycle: "exited" },
    { session_class: "standalone" }, { terminal_epoch: "" },
  ])("refuses mismatched or unavailable authority: %j", (patch) => {
    const f = fixture(hmuxSession(1, patch));
    const result = runSessionCli(f.root, f.hmux, ["send", "session-1", "hello", "--workspace", "workspace-1"]);
    expect(result.status).not.toBe(0);
    expect(f.calls().some((args) => args.includes("command-input"))).toBe(false);
  });
  it("reports an unavailable tracked target without a stack trace", () => {
    const f = fixture(hmuxSession(1, { health: "unprobed" }));
    const result = runSessionCli(f.root, f.hmux, ["send", "session-1", "hello", "--track"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Nothing was sent");
    expect(result.stderr).not.toMatch(/^\s+at /m);
  });
  it.each([["--backend", "remote"], ["--idempotency-key", "request-1"], ["--window-label", "peer"]])("refuses unsupported routing before input: %j", (...options) => {
    const f = fixture();
    const result = runSessionCli(f.root, f.hmux, ["send", "session-1", "hello", ...options]);
    expect(result.status).not.toBe(0);
    expect(f.calls().some((args) => args.includes("command-input"))).toBe(false);
  });
  it("retries an inconclusive Session lookup and then sends once", () => {
    const unprobed = hmuxSession(1, { health: "unprobed", effectiveLifecycle: "unprobed" });
    const f = fixture(hmuxSession(), {}, { shows: [null, unprobed] });
    const result = runSessionCli(f.root, f.hmux, ["send", "session-1", "hello", "--json"]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).target).toEqual({ sessionId: "session-1", workspaceId: "workspace-1" });
    expect(f.calls().filter((args) => args.includes("show"))).toHaveLength(3);
    expect(f.calls().filter((args) => args.includes("command-input"))).toHaveLength(1);
  });
  it.each([[[], true], [["--workspace", "workspace-1"], false]])(
    "reports a lookup that keeps failing as inconclusive, with a retry hint and nothing written: %j",
    (scope, suggestsWorkspace) => {
      const f = fixture(hmuxSession(), {}, { shows: [null, null, null] });
      const result = runSessionCli(f.root, f.hmux, ["send", "session-1", "hello", ...scope]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("hmux_session_query_failed");
      expect(result.stderr).toContain("does not show that the Session exited");
      expect(result.stderr).toContain("Input was not sent; retry the same command");
      expect(result.stderr).not.toContain("No live managed Session");
      expect(result.stderr.includes("--workspace <workspace-id>") && result.stderr.includes("skip")).toBe(suggestsWorkspace);
      expect(f.calls().filter((args) => args.includes("show"))).toHaveLength(3);
      expect(f.calls().some((args) => args.includes("command-input"))).toBe(false);
    },
  );
  it("names an unanswered Host probe without calling the Session exited", () => {
    const f = fixture(hmuxSession(1, { health: "unprobed", effectiveLifecycle: "unprobed" }));
    const result = runSessionCli(f.root, f.hmux, ["send", "session-1", "hello", "--workspace", "workspace-1"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("did not answer its probe (unprobed) after 3 attempts");
    expect(result.stderr).toContain("does not show that the Session exited");
    expect(f.calls().filter((args) => args.includes("show"))).toHaveLength(3);
    expect(f.calls().some((args) => args.includes("command-input"))).toBe(false);
  });
  it("does not repeat a lookup that shows the Session exited", () => {
    const f = fixture(hmuxSession(1, { health: "exited", effectiveLifecycle: "exited" }));
    const result = runSessionCli(f.root, f.hmux, ["send", "session-1", "hello", "--workspace", "workspace-1"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("No live managed Session");
    expect(f.calls().filter((args) => args.includes("show"))).toHaveLength(1);
    expect(f.calls().some((args) => args.includes("command-input"))).toBe(false);
  });
  it("keeps send-keys on its typed refusal after an inconclusive lookup", () => {
    const f = fixture(hmuxSession(), {}, { shows: [null, null, null] });
    const result = runSessionCli(f.root, f.hmux, ["send-keys", "session-1", "Down", "--workspace", "workspace-1", "--json"]);
    expect(result.status).not.toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { code: "target_unavailable", deliveryState: "not_written" } });
    expect(f.calls().some((args) => args.includes("command-input"))).toBe(false);
  });
  it("does not retry an uncertain input receipt", () => {
    const f = fixture(hmuxSession(), { receipt: {terminalEpoch:"different"} });
    const result = runSessionCli(f.root, f.hmux, ["send", "session-1", "hello"]);
    expect(result.status).not.toBe(0);
    expect(f.calls().filter((args) => args.includes("command-input"))).toHaveLength(1);
  });
});
