import { describe, expect, test } from "vitest";
import {
  guardianFaultEnvironmentForPhase,
  unexpectedRuntimePids,
} from "./hmux-test-guardian-fault-matrix.mjs";

describe("Hmux guardian fault matrix", () => {
  test("forces the owner-loss cleanup handoff only during the test body", () => {
    expect(guardianFaultEnvironmentForPhase("test_body")).toEqual({
      DURE_HMUX_FAULT_WRITE_BODY_MARKER: "1",
      DURE_QA_TEST_OWNER_LOSS_TERMINATION_FAILURE: "1",
    });
    expect(
      guardianFaultEnvironmentForPhase("host_ready_published"),
    ).toEqual({});
  });

  test("allows baseline runtimes to exit but rejects newly stranded runtimes", () => {
    expect(unexpectedRuntimePids([11, 22], [22])).toEqual([]);
    expect(unexpectedRuntimePids([11, 22], [22, 33])).toEqual([33]);
  });
});
