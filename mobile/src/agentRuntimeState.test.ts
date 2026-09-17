import { describe, expect, it } from "vitest";
import { viewportFrameRecord } from "@/test/terminalRecordFixtures";
import { approvalIdentity, parseAgentRuntimeRecord } from "./agentRuntimeState";

const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

function runtimeRecord(payload: Record<string, unknown>): Uint8Array {
  return encode({
    kind: "control",
    body: { kind: "agent_runtime_state", payload },
  });
}

const FULL_PAYLOAD = {
  terminal_epoch: "epoch-1",
  revision: "2",
  observed_through_output_seq: "1",
  lifecycle: "running",
  activity: "waiting",
  attention: "approval_required",
  attention_id: "appr-1",
  source: "provider_event",
  turn_completed_count: "3",
};

describe("parseAgentRuntimeRecord", () => {
  it("parses the relayed agent_runtime_state control record", () => {
    expect(parseAgentRuntimeRecord(runtimeRecord(FULL_PAYLOAD))).toEqual({
      lifecycle: "running",
      activity: "waiting",
      attention: "approval_required",
      attentionId: "appr-1",
      revision: "2",
      turnCompletedCount: "3",
    });
  });

  /**
   * The Host omits `turn_completed_count` when it is zero and documents that
   * absence means zero; parsing it as unknown made the first finished turn
   * (0→1) invisible to the counter.
   */
  it("leaves out an absent attention id and reads an absent turn counter as zero", () => {
    const { attention_id: _id, turn_completed_count: _count, ...rest } = FULL_PAYLOAD;
    expect(parseAgentRuntimeRecord(runtimeRecord({ ...rest, attention: "none" }))).toEqual({
      lifecycle: "running",
      activity: "waiting",
      attention: "none",
      revision: "2",
      turnCompletedCount: "0",
    });
  });

  it("returns null for viewport bytes", () => {
    const record = viewportFrameRecord({
      terminalEpoch: "epoch-1",
      stateRevision: 1n,
      throughOutputSeq: 1n,
      texts: ["ready"],
    });
    expect(parseAgentRuntimeRecord(record)).toBeNull();
  });

  it("returns null for JSON that is not a control record", () => {
    expect(parseAgentRuntimeRecord(encode({ kind: "closed", message: "bye" }))).toBeNull();
    expect(parseAgentRuntimeRecord(encode([1, 2]))).toBeNull();
    expect(parseAgentRuntimeRecord(encode(null))).toBeNull();
  });

  it("returns null for exit and error control records", () => {
    expect(
      parseAgentRuntimeRecord(
        encode({ kind: "control", body: { kind: "exit", payload: { reason: "done" } } }),
      ),
    ).toBeNull();
    expect(
      parseAgentRuntimeRecord(
        encode({ kind: "control", body: { kind: "error", payload: { message: "boom" } } }),
      ),
    ).toBeNull();
  });

  it("returns null for a runtime record whose payload is off-shape", () => {
    expect(parseAgentRuntimeRecord(runtimeRecord({ ...FULL_PAYLOAD, attention: "shrug" }))).toBeNull();
    expect(parseAgentRuntimeRecord(runtimeRecord({ ...FULL_PAYLOAD, revision: 2 }))).toBeNull();
    expect(parseAgentRuntimeRecord(runtimeRecord({ ...FULL_PAYLOAD, attention_id: 7 }))).toBeNull();
    expect(
      parseAgentRuntimeRecord(encode({ kind: "control", body: { kind: "agent_runtime_state" } })),
    ).toBeNull();
  });

  it("never throws on malformed bytes", () => {
    expect(parseAgentRuntimeRecord(new TextEncoder().encode("{not json"))).toBeNull();
    expect(parseAgentRuntimeRecord(new Uint8Array([0xff, 0xfe]))).toBeNull();
  });
});

describe("approvalIdentity", () => {
  const parsed = (payload: Record<string, unknown>) => {
    const state = parseAgentRuntimeRecord(runtimeRecord({ ...FULL_PAYLOAD, ...payload }));
    if (!state) throw new Error("record expected to parse");
    return state;
  };

  it("is the Host's attention id while an approval is pending, and nothing otherwise", () => {
    expect(approvalIdentity(parsed({}))).toBe("appr-1");
    expect(approvalIdentity(parsed({ attention: "none", attention_id: undefined }))).toBeUndefined();
    expect(approvalIdentity(parsed({ attention: "input_required", attention_id: "q-1" }))).toBeUndefined();
  });

  it("tells an unnamed approval apart by its revision", () => {
    expect(approvalIdentity(parsed({ attention_id: undefined }))).toBe("revision:2");
    expect(approvalIdentity(parsed({ attention_id: undefined, revision: "3" }))).toBe("revision:3");
  });
});
