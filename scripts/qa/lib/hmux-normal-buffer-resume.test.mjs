import { describe, expect, test, vi } from "vitest";
import {
  assertNormalBufferResume,
  NORMAL_BUFFER_RESUME_DEFAULTS,
  runNormalBufferResumeScenario,
} from "./hmux-normal-buffer-resume.mjs";

const scrollbackMarker = "HMUX_SCROLL_QA_0123456789AB_READY";
const hiddenMarker = "HMUX_WINDOW_QA_0123456789AB_S_0001";
const inputMarker = "HMUX_WINDOW_QA_0123456789AB_A_0002";

function bufferState(overrides = {}) {
  return {
    bufferLength: 24,
    scrollbackRows: 1,
    viewportY: 0,
    atBottom: true,
    concealed: false,
    visibleScrollbackMarker: scrollbackMarker,
    ...overrides,
  };
}

function windowReport(overrides = {}) {
  return {
    hydrating: false,
    documentFocused: false,
    visibleFrameCount: 8,
    visibleFrameViolations: 0,
    renderMetrics: { snapshotCollapses: 4 },
    markerCounts: {
      [hiddenMarker]: 1,
      [inputMarker]: 1,
    },
    bufferState: bufferState(),
    ...overrides,
  };
}

function fixture(overrides = {}) {
  const immediateInput = {
    action: { marker: inputMarker },
    hostReceiptObservation: {
      snapshotCollapses: 5,
      scrollbackRows: 1,
      atBottom: true,
      concealed: false,
      historyHydrating: false,
      visibleScrollbackMarker: scrollbackMarker,
      visibleFrameCount: 6,
      visibleFrameViolations: 0,
    },
    timing: {
      inputToHostReceiptMs: 82,
      inputToEchoPaintMs: 164,
    },
  };
  return {
    initialHost: { sequenceThrough: "40", markerCounts: {} },
    hiddenHost: {
      sequenceThrough: "41",
      markerCounts: { [hiddenMarker]: 1 },
    },
    hiddenOutput: { marker: hiddenMarker },
    immediateInput,
    finalStatus: {
      windows: { a: windowReport(), b: windowReport() },
    },
    scrollbackMarker,
    config: NORMAL_BUFFER_RESUME_DEFAULTS,
    ...overrides,
  };
}

describe("normal-buffer foreground input regression", () => {
  test("accepts bounded tail projection catch-up before foreground input", () => {
    expect(assertNormalBufferResume(fixture())).toEqual({
      hiddenOutputSequence: "41",
      inputToHostReceiptMs: 82,
      inputToEchoPaintMs: 164,
      finalRowsFromTail: 0,
    });
  });

  test("rejects a foreground Host receipt outside the canonical tail", () => {
    const offTail = fixture();
    offTail.immediateInput.hostReceiptObservation.atBottom = false;
    expect(() => assertNormalBufferResume(offTail)).toThrow(
      "foreground viewport was not ready",
    );
  });

  test("enforces the immediate Host and echo-paint timing budgets", () => {
    const slowHost = fixture();
    slowHost.immediateInput.timing.inputToHostReceiptMs = 101;
    expect(() => assertNormalBufferResume(slowHost)).toThrow(
      "Host receipt 101ms exceeds 100ms",
    );

    const slowEcho = fixture();
    slowEcho.immediateInput.timing.inputToEchoPaintMs = 201;
    expect(() => assertNormalBufferResume(slowEcho)).toThrow(
      "echo paint 201ms exceeds 200ms",
    );
  });

  test("runs hide, hidden output, show, and immediate input in order", async () => {
    const calls = [];
    let snapshotReads = 0;
    const finalStatus = fixture().finalStatus;
    const initialStatus = {
      windows: {
        a: windowReport({
          visibleFrameCount: 5,
          markerCounts: {},
        }),
        b: windowReport({ markerCounts: {} }),
      },
    };
    const hiddenStatus = {
      presentation: "hidden",
      nativeWindows: { a: { visible: false }, b: { visible: false } },
      windows: {
        a: { documentFocused: false },
        b: { documentFocused: false },
      },
    };
    const harness = {
      snapshotEvidence: vi.fn(async () => {
        calls.push("snapshot");
        snapshotReads += 1;
        return snapshotReads === 1
          ? { sequenceThrough: "40", markerCounts: {} }
          : {
              sequenceThrough: "41",
              markerCounts: { [hiddenMarker]: 1 },
            };
      }),
      setPresentation: vi.fn(async (presentation) => {
        calls.push(`presentation:${presentation}`);
      }),
      status: vi
        .fn()
        .mockImplementationOnce(async () => {
          calls.push("status:hidden");
          return hiddenStatus;
        })
        .mockImplementationOnce(async () => {
          calls.push("status:final");
          return finalStatus;
        }),
      waitFor: vi.fn(async (_description, _timeout, read) => read()),
      inject: vi.fn(async () => {
        calls.push("inject");
        return { marker: hiddenMarker };
      }),
      measuredFocusedStep: vi.fn(async (role) => {
        calls.push(`input:${role}`);
        return fixture().immediateInput;
      }),
      waitForMarker: vi.fn(async (action) => {
        calls.push(`marker:${action.marker}`);
      }),
    };

    await expect(
      runNormalBufferResumeScenario({
        harness,
        initialStatus,
        scrollbackMarker,
        options: { hiddenHoldMs: 0 },
      }),
    ).resolves.toMatchObject({
      inputToHostReceiptMs: 82,
      inputToEchoPaintMs: 164,
    });
    expect(calls).toEqual([
      "snapshot",
      "presentation:hidden",
      "status:hidden",
      "inject",
      "snapshot",
      "presentation:visible",
      "input:a",
      `marker:${hiddenMarker}`,
      "status:final",
    ]);
  });
});
