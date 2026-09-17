import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, test } from "vitest";

const mockSource = readFileSync(
  new URL("./tauri-mock.js", import.meta.url),
  "utf8",
);
const perfSource = readFileSync(
  new URL("./frontend-perf.mjs", import.meta.url),
  "utf8",
);

function loadMock() {
  const sandbox = {
    atob,
    window: {},
  };
  runInNewContext(mockSource, sandbox);
  return sandbox.window.__TAURI_INTERNALS__;
}

describe("frontend performance Tauri mock contracts", () => {
  test("boots with no interrupted spawn receipts", async () => {
    const tauri = loadMock();

    await expect(tauri.invoke("spawn_receipts_list_running")).resolves.toEqual([]);
  });

  test("opens the performance terminal through the canonical Hmux surface", async () => {
    const tauri = loadMock();

    await expect(tauri.invoke("app_caps")).resolves.toMatchObject({
      features: expect.arrayContaining(["hmux.standalone-terminal-surface-v1"]),
    });
    const session = await tauri.invoke("hmux_standalone_create", { request: {} });
    const receipt = await tauri.invoke("hmux_structured_terminal_attach", {
      observerId: "perf-observer",
      sessionId: session.sessionId,
      workspaceId: session.workspaceId,
    });

    expect(receipt).toMatchObject({
      terminalEpoch: session.terminalEpoch,
      initialDeliveryRecordCount: 1,
      session,
    });
    await expect(
      tauri.invoke("hmux_structured_terminal_next", {
        observerId: "perf-observer",
      }),
    ).resolves.toHaveProperty("byteLength", 126);
    const resizeReceipt = tauri.invoke("hmux_structured_terminal_next", {
      observerId: "perf-observer",
    });
    await expect(
      tauri.invoke("hmux_structured_terminal_upstream", {
        observerId: "perf-observer",
        record: [],
      }),
    ).resolves.toBe("1");
    await expect(resizeReceipt).resolves.toHaveProperty("byteLength", 52);
    await expect(
      tauri.invoke("hmux_structured_terminal_next", {
        observerId: "perf-observer",
      }),
    ).resolves.toHaveProperty("byteLength", 631);
    expect(perfSource).toContain("dock.openLocalTerminalPanel(id)");
    expect(perfSource).not.toContain("openLegacyLocalTerminalOn");
  });
});
