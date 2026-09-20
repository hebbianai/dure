import { describe, expect, it } from "vitest";
import { performComputerInput } from "../cli/lib/computer-input.mjs";
import { runMacComputerInput } from "../cli/lib/macos-computer-input.mjs";

const target = { pid: 42, generation: "process-one" };
function desktop(overrides = {}) {
  let clock = 0;
  const calls = [];
  return {
    calls,
    resolve: () => [target],
    observe: () => ({ ...target, frontmostPid: 42 }),
    activate: (app) => { calls.push(["activate", app]); return true; },
    now: () => clock,
    wait: (ms) => { calls.push(["wait", ms]); clock += ms; },
    send: (request, app, beforePost) => { beforePost(); calls.push(["send", request]); },
    ...overrides,
  };
}
const input = { sub: "type", app: "QA", text: "hello 한글" };

describe("computer input transaction", () => {
  it("pins one process and checks it before activation, before and after input", () => {
    const observations = [];
    const adapter = desktop({ observe: (pid) => {
      observations.push(pid);
      return { ...target, frontmostPid: 42 };
    } });
    expect(performComputerInput(input, adapter)).toEqual({ ok: true, pid: 42, action: "type", inputAttempted: true });
    expect(adapter.calls).toEqual([["activate", target], ["send", input]]);
    expect(observations).toEqual([42, 42, 42, 42, 42]);
  });

  it.each([
    [[], "computer_app_not_running"],
    [[target, { pid: 43, generation: "process-two" }], "computer_app_ambiguous"],
    [[{ pid: 42 }], "computer_identity_unavailable"],
  ])("refuses unavailable or ambiguous targets", (candidates, code) => {
    const adapter = desktop({ resolve: () => candidates });
    expect(performComputerInput(input, adapter)).toMatchObject({ ok: false, error: { code, inputMayHaveBeenSent: false } });
    expect(adapter.calls).toEqual([]);
  });

  it("waits for delayed activation rather than guessing from elapsed time", () => {
    const adapter = desktop();
    adapter.observe = () => ({ ...target, frontmostPid: adapter.now() >= 650 ? 42 : 7 });
    expect(performComputerInput(input, adapter).ok).toBe(true);
    expect(adapter.now()).toBe(650);
    expect(adapter.calls.filter(([action]) => action === "send")).toHaveLength(1);
  });

  it("bounds activation waiting and never sends to another app", () => {
    const adapter = desktop({ observe: () => ({ ...target, frontmostPid: 7 }) });
    expect(performComputerInput(input, adapter)).toMatchObject({ ok: false, error: { code: "computer_activation_timeout", inputMayHaveBeenSent: false } });
    expect(adapter.now()).toBe(5000);
    expect(adapter.calls.some(([action]) => action === "send")).toBe(false);
  });

  it("does not retry a refused activation", () => {
    let activations = 0;
    const adapter = desktop({ activate: () => { activations++; return false; } });
    expect(performComputerInput(input, adapter).error.code).toBe("computer_activation_failed");
    expect(activations).toBe(1);
    expect(adapter.calls).toEqual([]);
  });

  it.each([null, { ...target, generation: "reused-pid" }, { ...target, pid: 43 }])(
    "rejects exit or replacement after selecting the process", (observation) => {
      const adapter = desktop({ observe: () => observation });
      expect(performComputerInput(input, adapter).error.code).toBe("computer_target_changed");
      expect(adapter.calls).toEqual([]);
    },
  );

  it.each([null, { ...target, generation: "new-process", frontmostPid: 42 }, { ...target, frontmostPid: 7 }])(
    "checks the target again immediately before sending", (changed) => {
      let observations = 0;
      const adapter = desktop({ observe: () => ++observations < 3 ? { ...target, frontmostPid: 42 } : changed });
      const outcome = performComputerInput(input, adapter);
      expect(outcome).toMatchObject({ ok: false, error: { inputMayHaveBeenSent: false } });
      expect(adapter.calls.some(([action]) => action === "send")).toBe(false);
    },
  );

  it.each([null, { ...target, frontmostPid: 7 }])("reports uncertain delivery after input, without retrying", (changed) => {
    let observations = 0;
    const adapter = desktop({ observe: () => ++observations < 5 ? { ...target, frontmostPid: 42 } : changed });
    expect(performComputerInput(input, adapter)).toMatchObject({ ok: false, error: { code: "computer_input_unconfirmed", inputMayHaveBeenSent: true } });
    expect(adapter.calls.filter(([action]) => action === "send")).toHaveLength(1);
  });

  it("does not claim no input when native dispatch raises", () => {
    const adapter = desktop({ send: (request, app, beforePost) => { beforePost(); throw new Error("dispatch failed"); } });
    expect(performComputerInput(input, adapter)).toMatchObject({ ok: false, error: { code: "computer_input_unconfirmed", inputMayHaveBeenSent: true } });
  });

  it("reports no input if preparation fails before posting an event", () => {
    const adapter = desktop({ send: () => { throw new Error("permission denied"); } });
    expect(performComputerInput(input, adapter)).toMatchObject({ ok: false, error: { inputMayHaveBeenSent: false } });
  });

  it("checks activate without dispatching a key", () => {
    const adapter = desktop();
    expect(performComputerInput({ sub: "activate", pid: 42 }, adapter)).toMatchObject({ ok: true, inputAttempted: false });
    expect(adapter.calls).toEqual([["activate", target]]);
  });
});

describe("macOS input receipt", () => {
  it.each([
    { status: null, error: { code: "ETIMEDOUT" } },
    { status: 0, stdout: "not-json" },
    { status: 0, stdout: '{"ok":true,"pid":0,"action":"type"}' },
    { status: 0, stdout: '{"ok":true,"pid":42,"action":"activate"}' },
    { status: 0, stdout: '{"ok":false,"error":{"code":"computer_focus_changed","message":"Focus changed"}}' },
  ])("never converts a failure or uncertain response into success", (result) => {
    expect(() => runMacComputerInput(input, { platform: "darwin", run: () => result })).toThrow();
  });

  it("does not launch osascript on unsupported platforms", () => {
    expect(() => runMacComputerInput(input, { platform: "linux", run: () => { throw new Error("called OS"); } })).toThrow("computer_unsupported_platform");
  });

  it("rejects a successful receipt for a different PID", () => {
    expect(() => runMacComputerInput({ ...input, pid: 42 }, { platform: "darwin", run: () => ({
      status: 0, stdout: '{"ok":true,"pid":43,"action":"type"}',
    }) })).toThrow("computer_invalid_receipt");
  });
});
