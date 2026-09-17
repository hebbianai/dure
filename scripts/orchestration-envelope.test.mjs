import { describe, expect, it } from "vitest";
import {
  createOrchestrationRequest,
  requestOrchestration,
} from "../cli/lib/orchestration-client.mjs";
import { isOrchestrationResponse } from "../cli/lib/contracts/orchestration-envelope.mjs";

describe("portable orchestration envelope", () => {
  it("preserves operation-owned bodies and receipts without interpreting them", async () => {
    const body = { after: 14, limit: 10 };
    const request = createOrchestrationRequest({ method: "events.read", body });
    expect(request.body).toBe(body);
    expect(Object.isFrozen(request)).toBe(true);
    const receipt = { events: [], nextCursor: 14 };
    const result = await requestOrchestration("fixture", request, {
      transportImplementation: async (_endpoint, value) => {
        expect(value).toBe(request);
        return { apiVersion: request.apiVersion, method: request.method, receipt };
      },
    });
    expect(result.receipt).toBe(receipt);
  });

  it.each(["", "Events.read", "events/read", "a".repeat(129)])(
    "rejects invalid method %s before transport",
    (method) => {
      expect(() => createOrchestrationRequest({ method, body: {} })).toThrow(
        "orchestration request is invalid",
      );
    },
  );

  it.each([null, [], "body", 1, undefined])("rejects non-record body %s", (body) => {
    expect(() => createOrchestrationRequest({ method: "events.read", body })).toThrow(
      "orchestration request is invalid",
    );
  });

  it.each(["version", "method", "missing receipt", "undefined receipt"])(
    "preserves the CLI error for %s",
    async (fault) => {
      const request = createOrchestrationRequest({ method: "events.read", body: {} });
      const result = { apiVersion: request.apiVersion, method: request.method, receipt: {} };
      if (fault === "version") result.apiVersion = "dure.orchestration/v2";
      if (fault === "method") result.method = "another.operation";
      if (fault === "missing receipt") delete result.receipt;
      if (fault === "undefined receipt") result.receipt = undefined;
      await expect(requestOrchestration("fixture", request, {
        transportImplementation: async () => result,
      })).rejects.toThrow("orchestration API version mismatch");
    },
  );

  it("leaves receipt schema validation to the operation", () => {
    expect(isOrchestrationResponse({
      apiVersion: "dure.orchestration/v1", method: "events.read", receipt: undefined,
    }, "events.read")).toBe(true);
  });
});
