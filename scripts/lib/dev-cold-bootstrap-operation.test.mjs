import { describe, expect, it } from "vitest";
import {
  coldBootstrapSessionName,
  createColdBootstrapOperation,
  parseColdBootstrapOperation,
  parseColdBootstrapOperationId,
} from "./dev-cold-bootstrap-operation.mjs";

describe("cold-bootstrap operation identity", () => {
  it("allocates one valid opaque operation identity", () => {
    const { operationId } = createColdBootstrapOperation();
    expect(operationId).toMatch(/^[a-f0-9]{64}$/);
    expect(parseColdBootstrapOperationId(operationId)).toBe(operationId);
  });

  it("binds the terminal dimensions when allocating an operation", () => {
    const operation = createColdBootstrapOperation();
    expect(operation).toEqual({
      operationId: expect.stringMatching(/^[a-f0-9]{64}$/),
      initialRows: 24,
      initialColumns: 80,
    });
    expect(parseColdBootstrapOperation(operation)).toEqual(operation);
    expect(() =>
      parseColdBootstrapOperation({ ...operation, initialRows: 0 }),
    ).toThrow(/initial rows/);
  });

  it("rejects malformed identities", () => {
    expect(() => parseColdBootstrapOperationId("f".repeat(32))).toThrow(
      /operation ID/,
    );
  });

  it("derives one stable session name from the exact operation binding", () => {
    const binding = {
      root: "/repo/.worktrees/live",
      channel: "dev-live-1234567890",
      operationId: "1".repeat(64),
    };
    expect(coldBootstrapSessionName(binding)).toBe(
      "dure-dev-19b69d66811db79a",
    );
    expect(
      coldBootstrapSessionName({ ...binding, operationId: "2".repeat(64) }),
    ).not.toBe(coldBootstrapSessionName(binding));
    expect(() =>
      coldBootstrapSessionName({ ...binding, operationId: "invalid" }),
    ).toThrow(/operation ID/);
  });
});
