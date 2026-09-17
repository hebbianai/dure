import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { observeProcessMembers, processMemberFromObservation } from "../../lib/process-identity.mjs";

// The caller keeps one native Codex app-server connection throughout. It uses
// mcpServer/tool/call on that exact loaded thread, never thread/resume/restart.
export async function verifyCodexIdleWorker({ call, threadId, history, codexExecutable, reportPath, activateExisting = false }) {
  const stateRoot = fs.realpathSync(process.env.DURE_HMUX_TEST_STATE_ROOT);
  assert.ok(path.basename(stateRoot).startsWith("dure-hmux-test."));
  const root = fs.realpathSync(path.join(stateRoot, "mcp-idle"));
  assert.equal(path.dirname(root), stateRoot);
  assert.equal(path.dirname(fs.realpathSync(path.dirname(reportPath))), stateRoot);
  const release = path.join(root, "release");
  const eventsPath = path.join(root, "events.jsonl");
  const records = () => fs.existsSync(eventsPath)
    ? fs.readFileSync(eventsPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
    : [];
  const evidence = { ok: false, nativeProviderVerified: false, threadId, workers: [], observations: [] };
  async function waitFor(predicate, message) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const result = await predicate();
      if (result) return result;
      await delay(20);
    }
    throw new Error(message);
  }
  async function current(pid) {
    const observation = await observeProcessMembers({ kind: "point", pids: [pid] });
    evidence.observations.push(observation);
    assert.equal(observation.status, "complete", JSON.stringify(observation));
    return processMemberFromObservation(pid, observation);
  }
  async function present(pid) {
    const value = await current(pid);
    assert.equal(value.status, "present", JSON.stringify(value));
    return value.member;
  }
  async function gone(member) {
    await waitFor(async () => {
      const observed = await current(member.pid);
      return observed.status === "departed" || (observed.status === "present" && observed.member.processIdentity !== member.processIdentity);
    }, "native MCP worker generation did not exit");
  }
  try {
    if (activateExisting) {
      const callDure = (hold = false) => call("mcpServer/tool/call", {
        threadId, server: "resource_fixture", tool: "orchestration_interaction_get", arguments: { body: { hold } },
      });
      const first = await callDure();
      assert.equal(JSON.parse(first.content[0].text).receipt.call, 1);
      const previousWorker = await present(records().findLast((event) => event.event === "started").pid);
      const provider = await present(previousWorker.parentPid);
      const kept = await call("mcpServer/tool/call", { threadId, server: "keep", tool: "counter", arguments: {} });
      assert.equal(kept.content[0].text, "resource-counter-1");
      const providerRoot = path.dirname(reportPath);
      const keepRecord = fs.readFileSync(path.join(providerRoot, "mcp-events.jsonl"), "utf8")
        .trim().split("\n").map(JSON.parse).findLast((event) => event.event === "started");
      const keep = await present(keepRecord.pid);
      assert.equal(keep.parentPid, provider.pid);
      evidence.activation = { previousWorker, provider, keep };
      const held = callDure(true);
      const outcome = held.then((response) => ({ response }), (error) => ({ error }));
      await waitFor(() => records().some((event) => event.pid === previousWorker.pid && event.event === "called" && event.call === 2), "existing Dure MCP call did not enter");
      const update = JSON.parse(fs.readFileSync(path.join(providerRoot, "idle-entry-update.json"), "utf8"));
      const configPath = path.join(providerRoot, "profile", "config.toml");
      const readProfile = async () => {
        const read = await call("config/read", { includeLayers: true, cwd: providerRoot });
        const profiles = read.layers.filter((layer) => layer.name.type === "user");
        assert.equal(profiles.length, 1);
        const profile = profiles[0];
        assert.equal(fs.realpathSync(profile.name.file), fs.realpathSync(configPath));
        assert.equal(typeof profile.version, "string");
        assert.ok(profile.version.length > 0);
        assert.ok(profile.config.mcp_servers.resource_fixture);
        return profile;
      };
      const original = await readProfile();
      // Exercise an actual intervening edit, not a malformed version token.
      const intervening = await call("config/batchWrite", {
        expectedVersion: original.version, reloadUserConfig: false,
        edits: [{ keyPath: "check_for_update_on_startup", value: true, mergeStrategy: "replace" }],
      });
      assert.equal(fs.realpathSync(intervening.filePath), fs.realpathSync(configPath));
      const latest = await readProfile();
      assert.notEqual(latest.version, original.version);
      const upgrade = {
        expectedVersion: original.version, reloadUserConfig: false,
        edits: [{ keyPath: "mcp_servers.resource_fixture", value: update, mergeStrategy: "replace" }],
      };
      const beforeRefusal = fs.readFileSync(configPath, "utf8");
      await assert.rejects(call("config/batchWrite", upgrade), /version|conflict/i);
      assert.equal(fs.readFileSync(configPath, "utf8"), beforeRefusal);
      const written = await call("config/batchWrite", { ...upgrade, expectedVersion: latest.version });
      assert.equal(fs.realpathSync(written.filePath), fs.realpathSync(configPath));
      const after = await readProfile();
      const expected = structuredClone(latest.config);
      expected.mcp_servers.resource_fixture = update;
      assert.deepEqual(after.config, expected);
      assert.equal(after.config.check_for_update_on_startup, true);
      evidence.activation.configOwner = {
        method: "config/batchWrite", expectedVersionRefusalVerified: true,
        unrelatedConfigPreserved: true, filePath: written.filePath,
      };
      await call("config/mcpServer/reload", null);
      await delay(1_100);
      assert.equal((await present(previousWorker.pid)).processIdentity, previousWorker.processIdentity);
      fs.writeFileSync(release, "release");
      const settled = await outcome;
      assert.equal(settled.error, undefined, settled.error?.message);
      assert.equal(JSON.parse(settled.response.content[0].text).receipt.call, 2);
      await gone(previousWorker);
      assert.equal((await present(provider.pid)).processIdentity, provider.processIdentity);
      assert.equal((await present(keep.pid)).processIdentity, keep.processIdentity);
    }
    for (let cycle = 0; cycle < 2; cycle++) {
      if (fs.existsSync(release)) fs.unlinkSync(release);
      const offset = records().length;
      const pending = call("mcpServer/tool/call", {
        threadId, server: "resource_fixture", tool: "orchestration_interaction_get", arguments: { body: { hold: true } },
      });
      const outcome = pending.then((response) => ({ response }), (error) => ({ error }));
      try {
        const started = await waitFor(() => records().slice(offset).find((event) => event.event === "started"), "native provider did not lazily start its MCP worker");
        const worker = await present(started.pid);
        const relay = await present(worker.parentPid);
        const provider = await present(relay.parentPid);
        assert.equal(
          fs.realpathSync(execFileSync("ps", ["-p", String(provider.pid), "-o", "comm="], { encoding: "utf8", timeout: 2_000 }).trim()),
          fs.realpathSync(codexExecutable),
        );
        if (evidence.provider) {
          assert.equal(provider.processIdentity, evidence.provider.processIdentity);
          assert.equal(relay.processIdentity, evidence.relay.processIdentity);
        } else {
          evidence.provider = provider;
          evidence.relay = relay;
          if (evidence.activation) {
            assert.equal(provider.processIdentity, evidence.activation.provider.processIdentity);
          }
        }
        evidence.workers.push(worker);
        await waitFor(() => records().slice(offset).find((event) => event.event === "called" && event.pid === worker.pid), "native MCP call did not enter");
        // The fixture's relay has a one-second idle interval; a held call must
        // outlive it without replacing either its worker or its native provider.
        await delay(1_100);
        assert.equal((await present(worker.pid)).processIdentity, worker.processIdentity);
        assert.equal((await present(provider.pid)).processIdentity, provider.processIdentity);
        fs.writeFileSync(release, "release");
        const settled = await outcome;
        assert.equal(settled.error, undefined, settled.error?.message);
        assert.notEqual(settled.response.isError, true, JSON.stringify(settled.response));
        const body = JSON.parse(settled.response.content[0].text);
        assert.equal(body.receipt.call, 1);
        await gone(worker);
        assert.equal((await present(relay.pid)).processIdentity, relay.processIdentity);
        assert.equal((await present(provider.pid)).processIdentity, provider.processIdentity);
        assert.equal(records().slice(offset).filter((event) => event.event === "called").length, 1);
      } finally {
        fs.writeFileSync(release, "release");
      }
    }
    if (evidence.activation) {
      const kept = await call("mcpServer/tool/call", { threadId, server: "keep", tool: "counter", arguments: {} });
      assert.equal(kept.content[0].text, "resource-counter-2");
      assert.equal((await present(evidence.activation.keep.pid)).processIdentity, evidence.activation.keep.processIdentity);
    }
    const retained = await call("thread/turns/list", { threadId, limit: 10, sortDirection: "asc", itemsView: "full" });
    assert.deepEqual(retained.data.map((turn) => turn.id), history.data.map((turn) => turn.id));
    evidence.retainedTurnIds = retained.data.map((turn) => turn.id);
    evidence.nativeProviderVerified = true;
    evidence.ok = true;
  } catch (error) {
    evidence.error = error.stack ?? String(error);
    throw error;
  } finally {
    fs.writeFileSync(release, "release");
    fs.writeFileSync(reportPath, JSON.stringify(evidence, null, 2));
  }
  return evidence;
}
