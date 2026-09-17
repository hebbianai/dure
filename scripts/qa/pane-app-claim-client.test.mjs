import assert from "node:assert/strict";
import { test } from "vitest";
import { runPaneAppClaimQa } from "./pane-app-claim-client.mjs";

function fixture(fault) {
  const proof = "00000000-0000-4000-8000-000000000001";
  const terminals = ["pane-neutral", `launcher:${proof}`, "pane-destination"].map((paneId, index) => ({
    paneId, sessionId: `session-${index}`, workspaceId: "owned", terminalEpoch: `epoch-${index}`,
  }));
  const cases = terminals.slice(0, 2).flatMap(({ paneId }, index) =>
    ["refresh", "aba", "change"].map((mode) => ({ paneId, mode, idempotencyKey: `${proof}.claim.${index}.${mode}` })));
  const runtime = terminals.map((terminal, index) => ({
    session_id: terminal.sessionId, workspace_id: terminal.workspaceId, terminal_epoch: terminal.terminalEpoch,
    providerProcess: { process_id: 300 + index },
  }));
  const rows = [];
  const receipts = new Map();
  const requests = [];
  const io = {
    input: (marker) => ({ marker }),
    async act(body, { discardResponse = false } = {}) {
      requests.push(structuredClone(body));
      let result = receipts.get(body.idempotencyKey);
      if (!result || fault === "duplicate execution") {
        const scenario = cases.find((entry) => entry.idempotencyKey === body.idempotencyKey);
        const changed = scenario && scenario.mode !== "refresh";
        if (changed && fault !== "accepted changed recipient") {
          result = { error: { code: "pane_changed", retryable: fault === "retryable changed recipient" } };
          if (fault === "refusal after input") rows.push(`${body.idempotencyKey}:302`);
        } else {
          const index = scenario ? terminals.findIndex(({ paneId }) => paneId === body.targetPanelId) : 2;
          if (fault !== "acknowledgement without input") {
            rows.push(`${body.idempotencyKey}:${fault === "wrong process" ? 900 : 300 + index}`);
          }
          result = { ok: true, pane: { paneId: body.targetPanelId, invoked: "terminal.input", result: { outcome: "applied" } } };
        }
        receipts.set(body.idempotencyKey, result);
      }
      if (discardResponse && fault !== "missing response loss") {
        throw Object.assign(new Error("discarded response body"), { code: "client_request_failed" });
      }
      if (result.error) throw Object.assign(new Error("recipient changed"), result.error);
      return structuredClone(result);
    },
    async waitForRow(row) { assert.ok(rows.includes(row), `Missing shell-produced row: ${row}`); },
    rows: async () => [...rows],
  };
  return { options: { proof, fixture: { terminals }, cases, runtime }, io, rows, requests, receipts };
}

test("checks neutral/legacy claim transitions and replays one execution after a lost response", async () => {
  const f = fixture();
  const observations = await runPaneAppClaimQa(f.options, f.io);
  assert.equal(observations.length, 8);
  assert.equal(observations.filter(({ outcome }) => outcome === "pane_changed").length, 4);
  assert.equal(f.rows.length, 4);
  assert.equal(f.receipts.size, 8);
  assert.equal(f.requests.length, 16);
  for (const { idempotencyKey, mode } of f.options.cases) {
    const attempts = f.requests.filter((body) => body.idempotencyKey === idempotencyKey);
    assert.equal(attempts.length, mode === "refresh" ? 3 : 2);
    assert.ok(attempts.every((body) => JSON.stringify(body) === JSON.stringify(attempts[0])));
  }
});

for (const fault of ["duplicate execution", "wrong process", "refusal after input", "accepted changed recipient",
  "retryable changed recipient", "acknowledgement without input", "missing response loss"]) {
  test(`rejects ${fault} instead of certifying native command delivery`, async () => {
    const f = fixture(fault);
    await assert.rejects(runPaneAppClaimQa(f.options, f.io));
  });
}

test("rejects missing, retargeted or unrelated claim cases before sending any input", async () => {
  for (const change of [
    (options) => { delete options.cases; },
    (options) => { options.cases.pop(); },
    (options) => { options.cases[0].paneId = "pane-unrelated"; },
    (options) => { options.cases[0].idempotencyKey = "another-proof"; },
    (options) => { options.cases[0].idempotencyKey = options.cases[1].idempotencyKey; },
  ]) {
    const f = fixture();
    change(f.options);
    await assert.rejects(runPaneAppClaimQa(f.options, f.io));
    assert.equal(f.requests.length, 0);
  }
});
