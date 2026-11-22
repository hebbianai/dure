import { describe, expect, it, vi } from "vitest";
import type { AgentRuntimeState } from "./agentRuntimeState";
import { createApprovalGate } from "./approvalGate";
import type { BiometricCheck } from "./biometricLock";

function runtime(overrides: Partial<AgentRuntimeState> = {}): AgentRuntimeState {
  return {
    lifecycle: "running",
    activity: "waiting",
    attention: "approval_required",
    attentionId: "appr-1",
    revision: "2",
    turnCompletedCount: "0",
    ...overrides,
  };
}

/** A prompt whose answer the test hands out by hand. */
function harness(enabled = true) {
  const answers: ((check: BiometricCheck) => void)[] = [];
  const confirm = vi.fn(
    () =>
      new Promise<BiometricCheck>((resolve) => {
        answers.push(resolve);
      }),
  );
  const refused = vi.fn();
  const sent: string[] = [];
  const gate = createApprovalGate({ enabled: () => enabled, confirm, refused });
  const admit = (label: string) => gate.admit(() => sent.push(label));
  const answer = async (check: BiometricCheck) => {
    const resolve = answers.shift();
    if (!resolve) throw new Error("no prompt open");
    resolve(check);
    await Promise.resolve();
    await Promise.resolve();
  };
  return { gate, confirm, refused, sent, admit, answer };
}

describe("createApprovalGate", () => {
  it("sends synchronously while the preference is off, whatever the agent wants", () => {
    const { gate, confirm, sent, admit } = harness(false);
    gate.observe(runtime());
    admit("a");
    expect(sent).toEqual(["a"]);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("sends synchronously while nothing is waiting for approval", () => {
    const { gate, confirm, sent, admit } = harness();
    admit("before-any-state");
    gate.observe(runtime({ attention: "none", attentionId: undefined }));
    admit("none");
    gate.observe(runtime({ attention: "input_required", attentionId: "q-1" }));
    admit("input");
    expect(sent).toEqual(["before-any-state", "none", "input"]);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("prompts once for an approval, queues behind the prompt, then flushes in order", async () => {
    const { confirm, sent, admit, answer, gate } = harness();
    gate.observe(runtime());

    admit("a");
    admit("b");
    expect(sent).toEqual([]);
    expect(confirm).toHaveBeenCalledTimes(1);

    await answer("passed");
    expect(sent).toEqual(["a", "b"]);

    // Same approval, already proven: straight through.
    admit("c");
    expect(sent).toEqual(["a", "b", "c"]);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("drops the queue and refuses once when the sheet is cancelled", async () => {
    const { confirm, refused, sent, admit, answer, gate } = harness();
    gate.observe(runtime());

    admit("a");
    admit("b");
    await answer("cancelled");
    expect(sent).toEqual([]);
    expect(refused).toHaveBeenCalledTimes(1);
    expect(refused).toHaveBeenLastCalledWith("cancelled");

    // Still the same unanswered approval: the next press asks again.
    admit("c");
    expect(confirm).toHaveBeenCalledTimes(2);
    await answer("passed");
    expect(sent).toEqual(["c"]);
  });

  it("treats an unavailable or failed check as a refusal, never a bypass", async () => {
    for (const outcome of ["unavailable", "failed"] as const) {
      const { refused, sent, admit, answer, gate } = harness();
      gate.observe(runtime());
      admit("a");
      await answer(outcome);
      expect(sent).toEqual([]);
      // Named, so the banner can say what happened rather than "cancelled" for all.
      expect(refused).toHaveBeenCalledWith(outcome);
    }
  });

  it("re-arms for a new approval id", async () => {
    const { confirm, sent, admit, answer, gate } = harness();
    gate.observe(runtime({ attentionId: "appr-1" }));
    admit("a");
    await answer("passed");

    gate.observe(runtime({ attentionId: "appr-2" }));
    admit("b");
    expect(sent).toEqual(["a"]);
    expect(confirm).toHaveBeenCalledTimes(2);
    await answer("passed");
    expect(sent).toEqual(["a", "b"]);
  });

  it("does not prompt for an approval that ended while the sheet was up", async () => {
    const { sent, admit, answer, gate } = harness();
    gate.observe(runtime());
    admit("a");
    gate.observe(runtime({ attention: "none", attentionId: undefined }));
    admit("b");
    // "b" waits for the open prompt — the queue keeps its order — and the
    // answer releases both.
    expect(sent).toEqual([]);
    await answer("passed");
    expect(sent).toEqual(["a", "b"]);
  });

  it("reset forgets the approval and the queue", async () => {
    const { refused, sent, admit, answer, gate } = harness();
    gate.observe(runtime());
    admit("a");
    gate.reset();
    admit("b");
    expect(sent).toEqual(["b"]);
    // The stale prompt's answer must not release "a" into a new attachment.
    await answer("passed");
    expect(sent).toEqual(["b"]);
    expect(refused).not.toHaveBeenCalled();
  });
});

describe("an answer to a named approval (home's cards)", () => {
  it("asks once per approval it names, whatever the gate observed", async () => {
    const { gate, confirm, sent, answer } = harness();
    // Nothing observed: home has no stream, and names the approval itself.
    gate.answer("card-1", () => sent.push("allow-1"));
    expect(confirm).toHaveBeenCalledTimes(1);
    await answer("passed");
    expect(sent).toEqual(["allow-1"]);

    gate.answer("card-1", () => sent.push("again-1"));
    expect(sent).toEqual(["allow-1", "again-1"]);
    expect(confirm).toHaveBeenCalledTimes(1);

    gate.answer("card-2", () => sent.push("deny-2"));
    expect(confirm).toHaveBeenCalledTimes(2);
    await answer("passed");
    expect(sent).toEqual(["allow-1", "again-1", "deny-2"]);
  });

  it("never lets one proof release an answer to another approval", async () => {
    const { gate, confirm, refused, sent, answer } = harness();
    const dropped: string[] = [];
    gate.answer("card-1", () => sent.push("allow-1"), () => dropped.push("allow-1"));
    gate.answer("card-2", () => sent.push("allow-2"), () => dropped.push("allow-2"));
    expect(confirm).toHaveBeenCalledTimes(1);

    await answer("passed");
    // The first is proven and sent; the second asks for its own approval.
    expect(sent).toEqual(["allow-1"]);
    expect(confirm).toHaveBeenCalledTimes(2);

    await answer("cancelled");
    expect(sent).toEqual(["allow-1"]);
    expect(dropped).toEqual(["allow-2"]);
    expect(refused).toHaveBeenCalledWith("cancelled");
  });

  it("asks again for a terminal approval that changed while the sheet was up", async () => {
    const { gate, confirm, sent, admit, answer } = harness();
    gate.observe(runtime({ attentionId: "appr-1" }));
    admit("a");
    gate.observe(runtime({ attentionId: "appr-2" }));
    admit("b");
    await answer("passed");
    expect(sent).toEqual(["a"]);
    expect(confirm).toHaveBeenCalledTimes(2);
    await answer("passed");
    expect(sent).toEqual(["a", "b"]);
  });

  it("sends without asking while the preference is off", () => {
    const { gate, confirm, sent } = harness(false);
    gate.answer("card-1", () => sent.push("allow"));
    expect(sent).toEqual(["allow"]);
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe("a send that waits on its result", () => {
  it("is told it was dropped by a refused sheet or a reset, never after it was sent", async () => {
    const { gate, sent, answer } = harness();
    gate.observe(runtime());
    const dropped: string[] = [];
    gate.admit(() => sent.push("approve"), () => dropped.push("approve"));
    await answer("cancelled");
    expect(sent).toEqual([]);
    expect(dropped).toEqual(["approve"]);

    gate.admit(() => sent.push("deny"), () => dropped.push("deny"));
    gate.reset();
    expect(dropped).toEqual(["approve", "deny"]);
    // The sheet that was up when the attachment went answers nothing.
    await answer("passed");
    expect(sent).toEqual([]);

    gate.observe(runtime({ attentionId: "appr-2" }));
    gate.admit(() => sent.push("allow"), () => dropped.push("allow"));
    await answer("passed");
    expect(sent).toEqual(["allow"]);
    expect(dropped).toEqual(["approve", "deny"]);
  });
});
