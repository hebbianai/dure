import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { HmuxWindowFocusHarness } from "./hmux-window-focus-harness.mjs";

const temporaryDirectories = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("Hmux window focus harness", () => {
  test("prepares the exact Vite entries after the native controller page loads", async () => {
    const harness = new HmuxWindowFocusHarness();
    harness.request = vi.fn().mockResolvedValue({
      ok: true,
      page: {
        nativeFinishedCount: 1,
        nativeUrl:
          "http://127.0.0.1:43123/index.html?qaWindowSmokeController=1",
      },
      nativeWindow: { exists: true, visible: false, focused: false },
    });
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: vi.fn().mockResolvedValue("transformed module"),
    });
    vi.stubGlobal("fetch", fetch);

    await expect(harness.waitControllerFixtureReady()).resolves.toMatchObject({
      page: { nativeFinishedCount: 1 },
      nativeWindow: { exists: true, visible: false, focused: false },
      frontendAssetPreparation: {
        state: "ready",
        assets: [
          { path: "/src/main.tsx", status: 200 },
          { path: "/src/qa/hmuxWindowFocus.tsx", status: 200 },
        ],
      },
    });
    expect(harness.request).toHaveBeenCalledTimes(1);
    expect(harness.request).toHaveBeenCalledWith(
      "GET",
      "/qa/hmux/window-focus/controller-ready",
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.map(([url]) => url.href)).toEqual([
      "http://127.0.0.1:43123/src/main.tsx",
      "http://127.0.0.1:43123/src/qa/hmuxWindowFocus.tsx",
    ]);
  });

  test("retains marker pipeline evidence when a later phase fails", async () => {
    const evidenceDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "hmux-focus-evidence-"),
    );
    temporaryDirectories.push(evidenceDirectory);
    vi.stubEnv("HEBBIAN_QA_EVIDENCE_DIR", evidenceDirectory);
    vi.stubEnv("HEBBIAN_QA_LAYER", "background");

    const harness = new HmuxWindowFocusHarness();
    harness.lastWindowStatus = { ok: true, windows: {} };
    harness.recordMarkerPipelineEvidence({
      action: { actionId: 7, marker: "HMUX_WINDOW_QA_TEST" },
    });

    await expect(
      harness.phase("delivery", "background_streaming", async () => {
        throw new Error("fixture failure");
      }),
    ).rejects.toThrow("fixture failure");

    const evidence = JSON.parse(
      fs.readFileSync(
        path.join(evidenceDirectory, "last-status.json"),
        "utf8",
      ),
    );
    expect(evidence.markerPipeline.action.actionId).toBe(7);
    expect(evidence.qaExecution).toMatchObject({
      layer: "background",
      failureClass: "background_streaming",
    });
  });

  test("records structured terminal cardinality in marker evidence", () => {
    const harness = new HmuxWindowFocusHarness();
    harness.lastWindowStatus = {
      ok: true,
      terminalSurfaceCount: 2,
      windows: {},
    };

    expect(
      harness.markerPipelineEvidence(
        { actionId: 7, marker: "HMUX_WINDOW_QA_TEST", window: "a" },
        {},
      ),
    ).toMatchObject({
      terminalSurfaceCount: 2,
    });
  });

  test("records the client proof before a lost start response", async () => {
    const harness = new HmuxWindowFocusHarness();
    harness.request = vi.fn().mockRejectedValue(new Error("response lost"));

    await expect(harness.start("background")).rejects.toThrow("response lost");

    expect(harness.proof).toMatch(/^[0-9a-f]{64}$/);
    expect(harness.request).toHaveBeenCalledWith(
      "POST",
      "/qa/hmux/window-focus/start",
      { profile: "background", proof: harness.proof },
    );
  });

  test("requires the new marker exactly once in both projections and the Host", async () => {
    const harness = new HmuxWindowFocusHarness();
    const action = { actionId: 9, marker: "new-marker", window: "a" };
    const report = (count, focused) => ({
      markerCounts: { "new-marker": count },
      firstSeenAtMs: { "new-marker": 101 },
      firstSeenFocused: { "new-marker": focused },
    });
    const complete = { windows: { a: report(1, true), b: report(1, false) } };
    harness.status = vi
      .fn()
      .mockResolvedValueOnce({ windows: { b: report(1, false) } })
      .mockResolvedValueOnce({
        windows: { a: report(0, true), b: report(1, false) },
      })
      .mockResolvedValueOnce({
        windows: { a: report(1, true), b: report(0, false) },
      })
      .mockResolvedValueOnce({
        windows: { a: report(1, true), b: report(2, false) },
      })
      .mockResolvedValueOnce(complete);
    harness.waitFor = vi.fn(async (_description, _timeout, read) => {
      for (let index = 0; index < 4; index += 1) {
        expect(await read()).toBeUndefined();
      }
      return read();
    });
    harness.snapshotEvidence = vi.fn().mockResolvedValue({
      markerCounts: { "new-marker": 1 },
    });

    await expect(
      harness.waitForMarker(action, { unfocusedRoles: ["b"] }),
    ).resolves.toMatchObject({
      status: complete,
      firstSeenAtMs: { a: 101, b: 101 },
    });
    expect(harness.status).toHaveBeenCalledTimes(5);
    expect(harness.snapshotEvidence).toHaveBeenCalledOnce();
  });

  test.each(["focused observer", "duplicate Host marker"])(
    "rejects complete projection evidence with a %s",
    async (failure) => {
      const harness = new HmuxWindowFocusHarness();
      const action = { actionId: 9, marker: "new-marker", window: "a" };
      harness.status = vi.fn().mockResolvedValue({
        windows: Object.fromEntries(
          ["a", "b"].map((role) => [role, {
            markerCounts: { "new-marker": 1 },
            firstSeenAtMs: { "new-marker": 101 },
            firstSeenFocused: {
              "new-marker": role === "a" || failure === "focused observer",
            },
          }]),
        ),
      });
      harness.waitFor = vi.fn((_description, _timeout, read) => read());
      harness.snapshotEvidence = vi.fn().mockResolvedValue({
        markerCounts: {
          "new-marker": failure === "duplicate Host marker" ? 2 : 1,
        },
      });

      await expect(
        harness.waitForMarker(action, { unfocusedRoles: ["b"] }),
      ).rejects.toThrow(
        failure === "focused observer"
          ? "B first painted new-marker while focused"
          : "new-marker was not present exactly once in the Host canonical snapshot",
      );
    },
  );

  test("passes a provider screen contract for the large-view profile", async () => {
    const harness = new HmuxWindowFocusHarness();
    harness.request = vi
      .fn()
      .mockImplementation(async (_method, _route, body) => ({ proof: body.proof }));

    await harness.start("large_view", {
      provider: "claude",
      screenModel: "alternate",
    });

    expect(harness.request).toHaveBeenCalledWith(
      "POST",
      "/qa/hmux/window-focus/start",
      {
        profile: "large_view",
        proof: harness.proof,
        provider: "claude",
        screenModel: "alternate",
      },
    );
  });

  test("closes one QA window with the active proof", async () => {
    const harness = new HmuxWindowFocusHarness();
    harness.proof = "proof";
    harness.request = vi.fn().mockResolvedValue({ ok: true });

    await harness.close("b");

    expect(harness.request).toHaveBeenCalledWith(
      "POST",
      "/qa/hmux/window-focus/close",
      { proof: "proof", window: "b" },
    );
  });

  test("reads the existing multi-window performance receipt", async () => {
    const harness = new HmuxWindowFocusHarness();
    const report = { projection: "terminal-input", complete: true };
    const receipt = { ok: true, projection: "terminal-input", report };
    harness.request = vi.fn().mockResolvedValue(receipt);

    await expect(harness.performanceReport()).resolves.toBe(receipt);
    expect(harness.request).toHaveBeenCalledWith("POST", "/perf/report", {
      projection: "terminal-input",
    });

    harness.request = vi.fn().mockResolvedValue({ ok: true, report: {} });
    await expect(harness.performanceReport()).rejects.toThrow(
      "performance report omitted multi-window input evidence",
    );

    harness.request = vi.fn().mockResolvedValue({
      ...receipt,
      projection: "full",
    });
    await expect(harness.performanceReport()).rejects.toThrow(
      "performance report omitted multi-window input evidence",
    );
  });

  test("waits for the exact WebView viewport-scroll action", async () => {
    const harness = new HmuxWindowFocusHarness();
    harness.proof = "proof";
    harness.request = vi.fn(async (_method, route) =>
      route === "/qa/hmux/window-focus/scroll-rows"
        ? { actionId: 7, rows: 512, window: "a" }
        : {
            windows: {
              a: { receivedActionId: 7, completedActionId: 7 },
            },
          },
    );

    await expect(harness.scrollRows("a", 512)).resolves.toMatchObject({
      action: { actionId: 7, rows: 512, window: "a" },
      status: {
        windows: { a: { receivedActionId: 7, completedActionId: 7 } },
      },
    });
    expect(harness.request).toHaveBeenNthCalledWith(
      1,
      "POST",
      "/qa/hmux/window-focus/scroll-rows",
      { proof: "proof", window: "a", rows: 512 },
    );
    await expect(harness.scrollRows("a", 0)).rejects.toThrow(
      "invalid QA viewport scroll",
    );
  });

  test("opens the real detached large-view route with the active proof", async () => {
    const harness = new HmuxWindowFocusHarness();
    harness.proof = "proof";
    harness.request = vi.fn().mockResolvedValue({ ok: true });

    await harness.openLargeView();

    expect(harness.request).toHaveBeenCalledWith(
      "POST",
      "/qa/hmux/window-focus/open-large-view",
      { proof: "proof" },
    );
  });

  test("prepares the runtime once through the fixture path with durable evidence", async () => {
    const evidenceDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "hmux-runtime-preparation-"),
    );
    temporaryDirectories.push(evidenceDirectory);
    vi.stubEnv("HEBBIAN_QA_EVIDENCE_DIR", evidenceDirectory);

    const harness = new HmuxWindowFocusHarness();
    harness.request = vi.fn().mockResolvedValueOnce({
      schemaVersion: 1,
      kind: "fixture_setup",
      buildId: "hmux-test-build",
    });

    await expect(harness.prepareRuntime()).resolves.toMatchObject({
      state: "ready",
      buildId: "hmux-test-build",
      attempts: 1,
    });
    expect(harness.request).toHaveBeenCalledTimes(1);
    expect(harness.request).toHaveBeenCalledWith(
      "POST",
      "/qa/hmux/runtime/prepare",
      undefined,
      35_000,
    );
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(evidenceDirectory, "runtime-preparation.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({
      state: "ready",
      buildId: "hmux-test-build",
      attempts: 1,
    });
  });

  test("records a terminal runtime preparation failure", async () => {
    const evidenceDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "hmux-runtime-preparation-failure-"),
    );
    temporaryDirectories.push(evidenceDirectory);
    vi.stubEnv("HEBBIAN_QA_EVIDENCE_DIR", evidenceDirectory);

    const harness = new HmuxWindowFocusHarness();
    harness.request = vi.fn().mockRejectedValueOnce(new Error("probe timed out"));

    await expect(harness.prepareRuntime()).rejects.toThrow("probe timed out");
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(evidenceDirectory, "runtime-preparation.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({
      kind: "fixture_setup",
      state: "failed",
      attempts: 1,
      lastError: "Error: probe timed out",
    });
  });

  test("fails closed when the app selects a runtime other than the staged build", async () => {
    const evidenceDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "hmux-runtime-preparation-skew-"),
    );
    temporaryDirectories.push(evidenceDirectory);
    vi.stubEnv("HEBBIAN_QA_EVIDENCE_DIR", evidenceDirectory);
    vi.stubEnv("DURE_QA_EXPECTED_HMUX_BUILD_ID", "hmux-current-build");

    const harness = new HmuxWindowFocusHarness();
    harness.request = vi.fn().mockResolvedValueOnce({
      schemaVersion: 1,
      kind: "fixture_setup",
      buildId: "hmux-stale-build",
    });

    await expect(harness.prepareRuntime()).rejects.toThrow(
      "runtime preparation selected hmux-stale-build; expected staged build hmux-current-build",
    );
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(evidenceDirectory, "runtime-preparation.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({ state: "failed", attempts: 1 });
  });

  test("focuses listening windows before waiting for hidden-document surfaces", async () => {
    const harness = new HmuxWindowFocusHarness();
    harness.proof = "proof";
    let focused = false;
    harness.request = vi.fn().mockImplementation(async (_method, route) => {
      if (route !== "/qa/hmux/window-focus/focus") {
        throw new Error(`unexpected route ${route}`);
      }
      focused = true;
      return { actionId: 1 };
    });
    harness.status = vi.fn().mockImplementation(async () => ({
      windows: {
        a: {
          completedActionId: focused ? 1 : undefined,
          hydrating: !focused,
          listening: true,
          mounted: focused,
          synchronized: focused,
        },
      },
    }));
    harness.waitFor = vi
      .fn()
      .mockImplementation(async (description, _timeoutMs, read) => {
        const value = await read();
        if (!value) throw new Error(`not ready: ${description}`);
        return value;
      });

    await expect(
      harness.waitReady({ primeRoles: ["a"], readyRoles: ["a"] }),
    ).resolves.toMatchObject({ windows: { a: { mounted: true } } });
    expect(harness.request).toHaveBeenCalledWith(
      "POST",
      "/qa/hmux/window-focus/focus",
      { proof: "proof", window: "a" },
    );
  });

  test.each([
    [
      "an attached surface is still retiring",
      { latestSurfaceAttachmentId: "attachment-a" },
      false,
    ],
    [
      "the latest attached surface has retired",
      {
        latestSurfaceAttachmentId: "attachment-a",
        latestRetiredSurfaceAttachmentId: "attachment-a",
      },
      true,
    ],
    ["the background profile never attached a surface", {}, true],
  ])("classifies hidden release when %s", async (_name, attachment, ready) => {
    const harness = new HmuxWindowFocusHarness();
    const status = {
      presentation: "hidden",
      controllerWindow: { exists: true, visible: false, focused: false },
      nativeWindows: Object.fromEntries(
        ["a", "b"].map((role) => [
          role,
          { exists: true, visible: false, focused: false },
        ]),
      ),
      windows: Object.fromEntries(
        ["a", "b"].map((role) => [
          role,
          {
            ...attachment,
            mounted: false,
            listening: true,
            documentFocused: false,
            controlState: "viewing",
          },
        ]),
      ),
    };
    harness.status = vi.fn().mockResolvedValue(status);
    harness.waitFor = vi
      .fn()
      .mockImplementation(async (_description, _timeoutMs, read) => read());

    await expect(harness.waitHiddenSurfaceRelease()).resolves.toEqual(
      ready ? status : undefined,
    );
  });

  test("observes hidden-time output through the Host without a renderer", async () => {
    const harness = new HmuxWindowFocusHarness();
    const action = { marker: "HMUX_WINDOW_QA_0123456789AB_B_0002" };
    const snapshot = { markerCounts: { [action.marker]: 1 } };
    harness.snapshotEvidence = vi.fn().mockResolvedValue(snapshot);
    harness.waitFor = vi
      .fn()
      .mockImplementation(async (_description, _timeoutMs, read) => read());

    await expect(harness.waitForHostMarker(action)).resolves.toEqual(snapshot);
    expect(harness.snapshotEvidence).toHaveBeenCalledOnce();
  });

  test("returns correlated Host receipt and complete-projection paint timings", async () => {
    const harness = new HmuxWindowFocusHarness();
    harness.proof = "proof";
    const action = { actionId: 9, marker: "marker-9", window: "a" };
    vi.spyOn(Date, "now").mockReturnValue(90);
    harness.request = vi.fn().mockResolvedValue(action);
    harness.waitForMarker = vi.fn().mockResolvedValue({
      status: {
        windows: {
          a: {
            markerWriteReceipts: {
              "marker-9": {
                requestId: "9",
                attachmentIdentity: "attachment-a:terminal-a",
                state: "written_to_pty",
                inputStartedAtMs: 100,
                hostReceiptAtMs: 124,
                observationAtHostReceipt: {
                  snapshotCollapses: 2,
                  scrollbackRows: 600,
                  atBottom: true,
                  concealed: false,
                  historyHydrating: true,
                  visibleFrameCount: 4,
                  visibleFrameViolations: 0,
                },
              },
            },
          },
        },
      },
      firstSeenAtMs: { a: 138 },
      firstPaintAtMs: { a: 141 },
    });

    await expect(harness.measuredFocusedStep("a")).resolves.toMatchObject({
      action,
      attachmentIdentity: "attachment-a:terminal-a",
      hostReceiptObservation: {
        snapshotCollapses: 2,
        scrollbackRows: 600,
        atBottom: true,
        concealed: false,
        historyHydrating: true,
        visibleFrameCount: 4,
        visibleFrameViolations: 0,
      },
      timing: {
        actionToInputStartMs: 10,
        actionToHostReceiptMs: 34,
        actionToProjectionCommitMs: 48,
        actionToEchoPaintMs: 51,
        inputToHostReceiptMs: 24,
        inputToEchoPaintMs: 41,
        hostReceiptToEchoPaintMs: 17,
        inputToProjectionCommitMs: 38,
        hostReceiptToProjectionCommitMs: 14,
        projectionCommitToEchoPaintMs: 3,
      },
    });
    expect(harness.waitForMarker).toHaveBeenCalledWith(action, {
      completedRole: "a",
      requiredRoles: ["a", "b"],
      unfocusedRoles: ["b"],
      paintedRole: "a",
    });
  });

  test("measures the first key after detached-window close without awaiting a retired observer", async () => {
    const harness = new HmuxWindowFocusHarness();
    harness.proof = "proof";
    const action = { actionId: 10, marker: "marker-10", window: "a" };
    vi.spyOn(Date, "now").mockReturnValue(190);
    harness.request = vi.fn().mockResolvedValue(action);
    harness.waitForMarker = vi.fn().mockResolvedValue({
      status: {
        windows: {
          a: {
            markerWriteReceipts: {
              "marker-10": {
                requestId: "10",
                attachmentIdentity: "attachment-b:terminal-a",
                state: "written_to_pty",
                inputStartedAtMs: 200,
                hostReceiptAtMs: 201,
                observationAtHostReceipt: {
                  snapshotCollapses: 1,
                  scrollbackRows: 0,
                  atBottom: true,
                  concealed: false,
                  historyHydrating: false,
                  visibleFrameCount: 1,
                  visibleFrameViolations: 0,
                },
              },
            },
          },
        },
      },
      firstSeenAtMs: { a: 202 },
      firstPaintAtMs: { a: 203 },
    });

    await harness.measuredFocusedStep("a", { requiredRoles: ["a"] });

    expect(harness.waitForMarker).toHaveBeenCalledWith(action, {
      completedRole: "a",
      requiredRoles: ["a"],
      unfocusedRoles: [],
      paintedRole: "a",
    });
  });
});
