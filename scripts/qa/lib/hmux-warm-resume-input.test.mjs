import { describe, expect, test, vi } from "vitest";
import {
  assertWarmResumeInput,
  runWarmResumeInputScenario,
} from "./hmux-warm-resume-input.mjs";

const hiddenMarker = "HMUX_WINDOW_QA_0123456789AB_S_0001";
const warmInputMarker = "HMUX_WINDOW_QA_0123456789AB_A_0002";
const coldInputMarker = "HMUX_WINDOW_QA_0123456789AB_A_0003";

function windowReport(overrides = {}) {
  return {
    mounted: true,
    synchronized: true,
    webviewInstanceId: "webview-a",
    synchronizationCount: 2,
    documentFocused: false,
    visibleFrameViolations: 0,
    markerCounts: {
      [hiddenMarker]: 1,
      [warmInputMarker]: 1,
      [coldInputMarker]: 1,
    },
    ...overrides,
  };
}

function fixture(overrides = {}) {
  return {
    baseline: {
      a: {
        visibleFrameViolations: 0,
        webviewInstanceId: "webview-a",
        synchronizationCount: 1,
      },
      b: {
        visibleFrameViolations: 0,
        webviewInstanceId: "webview-b",
        synchronizationCount: 1,
      },
    },
    initialHost: { sequenceThrough: "40", markerCounts: {} },
    hiddenHost: {
      sequenceThrough: "41",
      markerCounts: { [hiddenMarker]: 1 },
    },
    hiddenOutput: { marker: hiddenMarker },
    warmInput: {
      action: { marker: warmInputMarker },
      attachmentIdentity: "attachment-warm:terminal-epoch",
      timing: {
        actionToInputStartMs: 10,
        inputToHostReceiptMs: 7,
        inputToEchoPaintMs: 38,
      },
    },
    coldInput: {
      action: { marker: coldInputMarker },
      attachmentIdentity: "attachment-cold:terminal-epoch",
      hostReceiptObservation: {
        atBottom: true,
        concealed: false,
        visibleFrameViolations: 0,
      },
      timing: {
        actionToInputStartMs: 48,
        inputToHostReceiptMs: 7,
        inputToEchoPaintMs: 38,
        hostReceiptToProjectionCommitMs: 15,
        projectionCommitToEchoPaintMs: 16,
      },
      status: {
        windows: {
          a: windowReport({
            webviewInstanceId: "webview-a",
            synchronizationCount: 2,
          }),
        },
      },
    },
    finalStatus: {
      nativeWindows: { a: { visible: true }, b: { visible: true } },
      windows: {
        a: windowReport(),
        b: windowReport({ webviewInstanceId: "webview-b" }),
      },
    },
    finalHost: {
      sequenceThrough: "42",
      markerCounts: {
        [hiddenMarker]: 1,
        [warmInputMarker]: 1,
        [coldInputMarker]: 1,
      },
    },
    ...overrides,
  };
}

describe("warm-resume input observation", () => {
  test("accepts one hidden output followed by one measured foreground input", () => {
    expect(assertWarmResumeInput(fixture())).toEqual({
      hiddenOutputSequence: "41",
      warmActionToInputStartMs: 10,
      coldActionToInputStartMs: 48,
      inputToHostReceiptMs: 7,
      inputToEchoPaintMs: 38,
      hostReceiptToProjectionCommitMs: 15,
      projectionCommitToEchoPaintMs: 16,
    });
  });

  test("rejects Host duplication, incomplete frames, and slow input stages", () => {
    const duplicateHost = fixture();
    duplicateHost.finalHost.markerCounts[coldInputMarker] = 2;
    expect(() => assertWarmResumeInput(duplicateHost)).toThrow(
      "resumed Host did not retain",
    );

    const incompleteFrame = fixture();
    incompleteFrame.coldInput.hostReceiptObservation.visibleFrameViolations =
      1;
    expect(() => assertWarmResumeInput(incompleteFrame)).toThrow(
      "foreground viewport was not ready",
    );

    const hiddenSurface = fixture();
    hiddenSurface.finalStatus.nativeWindows.b.visible = false;
    expect(() => assertWarmResumeInput(hiddenSurface)).toThrow(
      "did not resume one complete visible surface",
    );

    const slowHost = fixture();
    slowHost.coldInput.timing.inputToHostReceiptMs = 101;
    expect(() => assertWarmResumeInput(slowHost)).toThrow(
      "Host receipt 101ms exceeds 100ms",
    );

    const slowPaint = fixture();
    slowPaint.coldInput.timing.inputToEchoPaintMs = 201;
    expect(() => assertWarmResumeInput(slowPaint)).toThrow(
      "echo paint 201ms exceeds 200ms",
    );

    const slowColdFocus = fixture();
    slowColdFocus.coldInput.timing.actionToInputStartMs = 101;
    expect(() => assertWarmResumeInput(slowColdFocus)).toThrow(
      "cold reveal to input 101ms exceeds 100ms",
    );

    const staleAttachment = fixture();
    staleAttachment.coldInput.attachmentIdentity =
      staleAttachment.warmInput.attachmentIdentity;
    expect(() => assertWarmResumeInput(staleAttachment)).toThrow(
      "did not replace its attachment",
    );

    const changedEpoch = fixture();
    changedEpoch.coldInput.attachmentIdentity =
      "attachment-cold:replacement-epoch";
    expect(() => assertWarmResumeInput(changedEpoch)).toThrow(
      "changed terminal epoch",
    );

    const replacedWebview = fixture();
    replacedWebview.coldInput.status.windows.a.webviewInstanceId = "webview-new";
    expect(() => assertWarmResumeInput(replacedWebview)).toThrow(
      "replaced its WebView",
    );

    const unsynchronizedRemount = fixture();
    unsynchronizedRemount.coldInput.status.windows.a.synchronizationCount = 1;
    expect(() => assertWarmResumeInput(unsynchronizedRemount)).toThrow(
      "did not synchronize a remounted surface",
    );
  });

  test("runs warm input, full hidden release, cold reveal input, and restore in order", async () => {
    const calls = [];
    let snapshotReads = 0;
    const initialStatus = {
      windows: {
        a: windowReport({ synchronizationCount: 1 }),
        b: windowReport({
          webviewInstanceId: "webview-b",
          synchronizationCount: 1,
        }),
      },
    };
    const finalStatus = fixture().finalStatus;
    const releasedStatus = {
      presentation: "hidden",
      nativeWindows: { a: { visible: false }, b: { visible: false } },
      windows: {
        a: { mounted: false, listening: true, documentFocused: false },
        b: { mounted: false, listening: true, documentFocused: false },
      },
    };
    const harness = {
      snapshotEvidence: vi.fn(async () => {
        calls.push("snapshot");
        snapshotReads += 1;
        if (snapshotReads === 1) return fixture().initialHost;
        if (snapshotReads === 2) return fixture().hiddenHost;
        return fixture().finalHost;
      }),
      setPresentation: vi.fn(async (presentation) => {
        calls.push(`presentation:${presentation}`);
      }),
      waitHiddenSurfaceRelease: vi.fn(async () => {
        calls.push("surfaces:released");
        return releasedStatus;
      }),
      waitFor: vi.fn(async (_description, _timeout, read) => read()),
      inject: vi.fn(async () => {
        calls.push("inject");
        return { marker: hiddenMarker };
      }),
      measuredFocusedStep: vi.fn(async (role, options) => {
        calls.push(
          `input:${role}:${options?.requiredRoles?.join("") ?? "all"}`,
        );
        return options?.requiredRoles ? fixture().coldInput : fixture().warmInput;
      }),
      waitForMarker: vi.fn(async (action) => {
        calls.push(`marker:${action.marker}`);
        return { status: finalStatus };
      }),
    };

    await expect(
      runWarmResumeInputScenario({ harness, initialStatus }),
    ).resolves.toMatchObject({
      inputToHostReceiptMs: 7,
      inputToEchoPaintMs: 38,
      coldActionToInputStartMs: 48,
    });
    expect(calls).toEqual([
      "snapshot",
      "input:a:all",
      "presentation:hidden",
      "surfaces:released",
      "inject",
      "snapshot",
      "input:a:a",
      "presentation:visible",
      `marker:${coldInputMarker}`,
      "snapshot",
    ]);
    expect(harness.measuredFocusedStep).toHaveBeenNthCalledWith(2, "a", {
      requiredRoles: ["a"],
    });
    expect(harness.waitForMarker).toHaveBeenCalledWith(
      fixture().coldInput.action,
      { unfocusedRoles: [] },
    );
  });
});
