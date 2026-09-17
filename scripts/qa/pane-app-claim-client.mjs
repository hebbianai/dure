import assert from "node:assert/strict";

/** Verify command recipients using shell-produced rows, not input acknowledgements. */
export async function runPaneAppClaimQa({ proof, fixture, cases, runtime }, io) {
  assert.ok(Array.isArray(cases), "Missing native pane claim cases");
  assert.deepEqual(cases.map(({ paneId, mode }) => [paneId, mode]),
    fixture.terminals.slice(0, 2).flatMap(({ paneId }) =>
      ["refresh", "aba", "change"].map((mode) => [paneId, mode])), "Incomplete pane claim coverage");
  assert.equal(new Set(cases.map(({ idempotencyKey }) => idempotencyKey)).size, 6);
  for (const entry of cases) {
    assert.ok(entry.idempotencyKey.startsWith(`${proof}.claim.`));
    assert.match(entry.idempotencyKey, /^[A-Za-z0-9_.-]{1,120}$/u);
  }
  const processFor = ({ sessionId, workspaceId, terminalEpoch }) => {
    const targets = runtime.filter((session) => session.session_id === sessionId &&
      session.workspace_id === workspaceId && session.terminal_epoch === terminalEpoch);
    assert.equal(targets.length, 1, "Claim recipient runtime is not exact");
    const pid = targets[0].providerProcess?.process_id;
    assert.ok(Number.isSafeInteger(pid) && pid > 1, "Missing recipient process identity");
    return pid;
  };
  const expectedRows = [];
  const observations = [];
  const applied = async (body, target, receipt) => {
    assert.equal(receipt.pane?.paneId, body.targetPanelId);
    assert.equal(receipt.pane?.invoked, "terminal.input");
    assert.equal(receipt.pane?.result?.outcome, "applied");
    const row = `${body.idempotencyKey}:${processFor(target)}`;
    await io.waitForRow(row);
    expectedRows.push(row);
    observations.push({ paneId: body.targetPanelId, idempotencyKey: body.idempotencyKey,
      outcome: "applied", sessionId: target.sessionId, row });
  };
  for (const entry of cases) {
    const body = { targetPanelId: entry.paneId, actionId: "terminal.input",
      idempotencyKey: entry.idempotencyKey, arguments: io.input(entry.idempotencyKey) };
    const target = fixture.terminals.find(({ paneId }) => paneId === entry.paneId);
    if (entry.mode === "refresh") {
      await assert.rejects(io.act(body, { discardResponse: true }), { code: "client_request_failed" });
      const receipt = await io.act(body);
      assert.deepEqual(await io.act(body), receipt, "Duplicate request did not replay the original receipt");
      await applied(body, target, receipt);
    } else {
      await assert.rejects(io.act(body), { code: "pane_changed", retryable: false });
      await assert.rejects(io.act(body), { code: "pane_changed", retryable: false });
      observations.push({ ...entry, outcome: "pane_changed" });
      if (entry.mode === "change") {
        const idempotencyKey = `${entry.idempotencyKey}.current`;
        const current = { ...body, idempotencyKey, arguments: io.input(idempotencyKey) };
        await applied(current, fixture.terminals[2], await io.act(current));
      }
    }
  }
  assert.deepEqual(await io.rows(), expectedRows,
    "Native input reached a wrong recipient, duplicated, or ran despite a refused claim");
  return observations;
}
