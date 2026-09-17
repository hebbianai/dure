import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { observeProcessMembers, processMemberFromObservation } from "../../lib/process-identity.mjs";

// Probe activation separately from idle retirement: changing our integration
// must not replace another MCP's stateful process in the same native provider.
export async function verifyCodexMcpReload({ call, root, threadId, history }) {
  const stateRoot = fs.realpathSync(process.env.DURE_HMUX_TEST_STATE_ROOT);
  assert.ok(path.basename(stateRoot).startsWith("dure-hmux-test."));
  assert.equal(fs.realpathSync(root), path.join(stateRoot, "codex-resources"));
  const report = { ok: false, liveActivation: false, threadId, observations: [] };
  const events = () => fs.readFileSync(path.join(root, "mcp-events.jsonl"), "utf8")
    .trim().split("\n").map(JSON.parse);
  async function waitFor(predicate, message) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await delay(20);
    }
    throw new Error(message);
  }
  async function present(pid) {
    const observation = await observeProcessMembers({ kind: "point", pids: [pid] });
    report.observations.push(observation);
    assert.equal(observation.status, "complete", JSON.stringify(observation));
    const current = processMemberFromObservation(pid, observation);
    assert.equal(current.status, "present", JSON.stringify(current));
    return current.member;
  }
  async function counter(server, hold = false) {
    const result = await call("mcpServer/tool/call", { threadId, server, tool: "counter", arguments: { hold } });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return result.content[0].text;
  }
  try {
    assert.equal(await counter("resource_fixture"), "resource-counter-1");
    assert.equal(await counter("keep"), "resource-counter-1");
    const started = (tag) => events().filter((event) => event.event === "started" && event.tag === tag).at(-1);
    report.before = {
      changed: await present(started("v1").pid),
      unchanged: await present(started("keep").pid),
    };
    report.provider = await present(report.before.changed.parentPid);
    assert.equal(report.before.unchanged.parentPid, report.provider.pid);
    const pending = counter("resource_fixture", true);
    const outcome = pending.then((response) => ({ response }), (error) => ({ error }));
    await waitFor(() => events().some((event) => event.event === "entered" && event.pid === report.before.changed.pid),
      "the old MCP worker did not enter its held call");
    const configPath = path.join(root, "profile", "config.toml");
    const config = fs.readFileSync(configPath, "utf8");
    const marker = 'DURE_QA_RESOURCE_MCP_TAG="v1"';
    assert.equal(config.split(marker).length, 2);
    fs.writeFileSync(configPath, config.replace(marker, 'DURE_QA_RESOURCE_MCP_TAG="v2"'));
    report.reload = await call("config/mcpServer/reload", null);
    // Reload admission is not a completed-call fact. Keep the active old
    // generation until the fixture explicitly releases its accepted work.
    await delay(1_100);
    report.heldAfterReload = await present(report.before.changed.pid);
    assert.equal(report.heldAfterReload.processIdentity, report.before.changed.processIdentity);
    fs.writeFileSync(path.join(root, "release-counter"), "release");
    const settled = await outcome;
    assert.equal(settled.error, undefined, settled.error?.message);
    assert.equal(settled.response, "resource-counter-2");
    await waitFor(() => started("v2"), "native MCP reload did not activate the changed configuration");
    report.after = {
      changed: await present(started("v2").pid),
      unchanged: await present(started("keep").pid),
      provider: await present(report.provider.pid),
    };
    report.unchangedCounter = await counter("keep");
    report.changedCounter = await counter("resource_fixture");
    assert.equal(report.after.provider.processIdentity, report.provider.processIdentity);
    assert.equal(report.after.unchanged.processIdentity, report.before.unchanged.processIdentity,
      "Codex MCP reload replaced an unchanged stateful server");
    assert.equal(report.unchangedCounter, "resource-counter-2");
    assert.equal(report.changedCounter, "resource-counter-1");
    await waitFor(async () => {
      const previous = report.before.changed;
      const observed = await observeProcessMembers({ kind: "point", pids: [previous.pid] });
      report.observations.push(observed);
      assert.equal(observed.status, "complete", JSON.stringify(observed));
      const current = processMemberFromObservation(previous.pid, observed);
      return current.status === "departed" ||
        (current.status === "present" && current.member.processIdentity !== previous.processIdentity);
    }, "native MCP reload retained the old worker after its call completed");
    const retained = await call("thread/turns/list", { threadId, limit: 10, sortDirection: "asc", itemsView: "full" });
    assert.deepEqual(retained.data.map((turn) => turn.id), history.data.map((turn) => turn.id));
    fs.writeFileSync(path.join(root, "processes-1.json"), JSON.stringify({
      members: [report.provider, ...Object.values(report.before), report.after.changed, report.after.unchanged],
    }), { flag: "wx", mode: 0o600 });
    report.ok = true;
  } catch (error) {
    report.error = error.stack ?? String(error);
    throw error;
  } finally {
    fs.writeFileSync(path.join(root, "release-counter"), "release");
    fs.writeFileSync(path.join(root, "mcp-reload.json"), JSON.stringify(report, null, 2));
  }
}
