import { describe, expect, it } from "vitest";
import {
  DEV_HMUX_STANDALONE_ACKNOWLEDGE_CAPABILITY,
  DEV_HMUX_STANDALONE_OPERATION_FRAME_LIMIT,
  DEV_HMUX_STANDALONE_OPERATION_MODE,
  DEV_HMUX_STANDALONE_RECONCILE_CAPABILITY,
  DEV_HMUX_STANDALONE_RETIRE_CAPABILITY,
  decodeDevHmuxStandaloneOperation,
  devHmuxStandaloneCommandEnvironmentValue,
  devHmuxStandaloneOperationExamples,
  encodeDevHmuxStandaloneOperation,
  parseDevHmuxStandaloneAcknowledgement,
  parseDevHmuxStandaloneOperationBinding,
  parseDevHmuxStandaloneRetirement,
} from "./dev-hmux-operation-contract.mjs";

function frame(value) {
  const payload = Buffer.from(JSON.stringify(value));
  const encoded = Buffer.allocUnsafe(payload.length + 4);
  encoded.writeUInt32BE(payload.length);
  payload.copy(encoded, 4);
  return encoded;
}

describe("development Hmux standalone operation wire", () => {
  const examples = devHmuxStandaloneOperationExamples();
  const request = examples.requestExample;

  it("shares one framed request and five validated outcomes", () => {
    expect(DEV_HMUX_STANDALONE_OPERATION_FRAME_LIMIT).toBe(256 * 1024);
    expect(DEV_HMUX_STANDALONE_RECONCILE_CAPABILITY).toBe(
      "standalone_create_operation_reconcile_v1",
    );
    expect(DEV_HMUX_STANDALONE_RETIRE_CAPABILITY).toBe(
      "standalone_create_operation_retire_completed_target_v1",
    );
    expect(DEV_HMUX_STANDALONE_ACKNOWLEDGE_CAPABILITY).toBe(
      "standalone_create_operation_retirement_acknowledge_v1",
    );
    expect(encodeDevHmuxStandaloneOperation(request)).toEqual(frame(request));
    expect(
      decodeDevHmuxStandaloneOperation(
        frame(examples.responseExamples.created),
        request,
      ),
    ).toEqual({
      outcome: "created",
      sessionName: request.sessionName,
      sessionId: `standalone_${request.operationId}`,
      workspaceId: "workspace_example",
    });
    expect(
      decodeDevHmuxStandaloneOperation(
        frame(examples.responseExamples.pending),
        request,
      ),
    ).toEqual({
      outcome: "pending",
      errorCode: "hmux_standalone_recovery_target_unavailable",
    });
    expect(
      decodeDevHmuxStandaloneOperation(
        frame(examples.responseExamples.refused),
        request,
      ),
    ).toEqual({
      outcome: "refused",
      errorCode: "hmux_standalone_recovery_name_conflict",
    });
    expect(
      decodeDevHmuxStandaloneOperation(
        frame(examples.responseExamples.retired),
        {
          ...request,
          mode: DEV_HMUX_STANDALONE_OPERATION_MODE.RECONCILE_COMPLETED_TARGET,
        },
      ),
    ).toEqual({
      outcome: "retired",
      schemaVersion: 1,
      operationId: request.operationId,
      sessionName: request.sessionName,
      sessionId: `standalone_${request.operationId}`,
      workspaceId: "workspace_example",
    });
    expect(
      decodeDevHmuxStandaloneOperation(
        frame(examples.responseExamples.acknowledged),
        examples.acknowledgeRequestExample,
      ),
    ).toEqual(examples.responseExamples.acknowledged);
  });

  it("uses an optional typed mode without changing canonical create input", () => {
    expect(Object.values(DEV_HMUX_STANDALONE_OPERATION_MODE).sort()).toEqual(
      [...examples.modes].sort(),
    );
    expect(examples.reconcileRequestExample.mode).toBe(
      DEV_HMUX_STANDALONE_OPERATION_MODE.RECONCILE_COMPLETED_TARGET,
    );
    expect(examples.retireRequestExample.mode).toBe(
      DEV_HMUX_STANDALONE_OPERATION_MODE.RETIRE_COMPLETED_TARGET,
    );
    expect(examples.acknowledgeRequestExample.mode).toBe(
      DEV_HMUX_STANDALONE_OPERATION_MODE.ACKNOWLEDGE_RETIRED_TARGET,
    );
    expect(
      encodeDevHmuxStandaloneOperation(examples.reconcileRequestExample),
    ).toEqual(frame(examples.reconcileRequestExample));
    expect(
      encodeDevHmuxStandaloneOperation(examples.retireRequestExample),
    ).toEqual(frame(examples.retireRequestExample));
    expect(
      encodeDevHmuxStandaloneOperation(examples.acknowledgeRequestExample),
    ).toEqual(frame(examples.acknowledgeRequestExample));
    expect(
      encodeDevHmuxStandaloneOperation({
        ...request,
        mode: DEV_HMUX_STANDALONE_OPERATION_MODE.CREATE,
      }),
    ).toEqual(frame(request));
    expect(() =>
      encodeDevHmuxStandaloneOperation({
        ...request,
        reconcileCompletedTarget: true,
      }),
    ).toThrow(/operation mode/);
    expect(() =>
      encodeDevHmuxStandaloneOperation({ ...request, mode: "reconcile" }),
    ).toThrow(/operation mode/);
    expect(
      decodeDevHmuxStandaloneOperation(
        frame(examples.responseExamples.retired),
        examples.retireRequestExample,
      ),
    ).toEqual(examples.responseExamples.retired);
    expect(() =>
      decodeDevHmuxStandaloneOperation(
        frame(examples.responseExamples.created),
        examples.retireRequestExample,
      ),
    ).toThrow(/operation receipt/);
  });

  it("projects exact tool paths from a saved command", () => {
    expect(
      devHmuxStandaloneCommandEnvironmentValue(
        ["env", "DURE_POSIX_SHELL=/nix/store/tools/bin/sh", "node"],
        "DURE_POSIX_SHELL",
      ),
    ).toBe("/nix/store/tools/bin/sh");
  });

  it("normalizes the exact immutable binding used by acknowledgement", () => {
    expect(
      parseDevHmuxStandaloneOperationBinding({
        operationId: request.operationId,
        sessionName: request.sessionName,
        command: request.command,
        initialRows: request.initialRows,
        initialColumns: request.initialColumns,
      }),
    ).toEqual({
      operationId: request.operationId,
      sessionName: request.sessionName,
      command: request.command,
      initialRows: request.initialRows,
      initialColumns: request.initialColumns,
    });
    expect(() =>
      parseDevHmuxStandaloneOperationBinding({
        operationId: request.operationId,
        sessionName: request.sessionName,
        command: request.command,
        initialRows: request.initialRows,
        initialColumns: request.initialColumns,
        mode: DEV_HMUX_STANDALONE_OPERATION_MODE.ACKNOWLEDGE_RETIRED_TARGET,
      }),
    ).toThrow(/operation binding/);
  });

  it("rejects an invalid session name at the request binding boundary", () => {
    expect(() =>
      encodeDevHmuxStandaloneOperation({
        ...request,
        sessionName: "invalid\nsession",
      }),
    ).toThrow(/operation binding/);
  });

  it("parses the persisted retirement proof against its exact operation", () => {
    const retired = examples.responseExamples.retired;
    expect(parseDevHmuxStandaloneRetirement(retired, request)).toEqual(retired);
    for (const invalid of [
      { ...retired, operationId: "b".repeat(64) },
      { ...retired, sessionName: "another-session" },
      { ...retired, sessionId: "standalone_wrong" },
      { ...retired, workspaceId: "" },
      { ...retired, privateProof: "not-public" },
    ]) {
      expect(() =>
        parseDevHmuxStandaloneRetirement(invalid, request),
      ).toThrow(/retirement receipt/);
    }
  });

  it("accepts only an exact correlated acknowledgement", () => {
    const acknowledged = examples.responseExamples.acknowledged;
    expect(
      parseDevHmuxStandaloneAcknowledgement(acknowledged, request),
    ).toEqual(acknowledged);
    expect(() =>
      parseDevHmuxStandaloneAcknowledgement(
        { ...acknowledged, operationId: "b".repeat(64) },
        request,
      ),
    ).toThrow(/acknowledgement receipt/);
  });

  it("rejects uncorrelated, private, malformed, and trailing response state", () => {
    const created = examples.responseExamples.created;
    for (const invalid of [
      { ...created, operationId: "b".repeat(64) },
      { ...created, sessionName: "another-session" },
      { ...created, sessionId: "standalone_wrong" },
      { ...created, launchOwnerProof: "private" },
      {
        ...examples.responseExamples.pending,
        errorCode: "not_hmux",
      },
      {
        ...examples.responseExamples.retired,
        operationId: "b".repeat(64),
      },
      {
        ...examples.responseExamples.retired,
        workspaceId: "workspace_example",
        errorCode: "hmux_private_state",
      },
      {
        ...examples.responseExamples.acknowledged,
        operationId: "b".repeat(64),
      },
    ]) {
      expect(() =>
        decodeDevHmuxStandaloneOperation(frame(invalid), request),
      ).toThrow(/invalid Hmux standalone operation/);
    }
    expect(() =>
      decodeDevHmuxStandaloneOperation(
        frame(examples.responseExamples.retired),
        request,
      ),
    ).toThrow(/invalid Hmux standalone operation/);
    expect(() =>
      decodeDevHmuxStandaloneOperation(
        frame(examples.responseExamples.created),
        examples.acknowledgeRequestExample,
      ),
    ).toThrow(/invalid Hmux standalone operation/);
    expect(() =>
      decodeDevHmuxStandaloneOperation(
        frame(examples.responseExamples.acknowledged),
        request,
      ),
    ).toThrow(/invalid Hmux standalone operation/);

    const valid = frame(created);
    expect(() =>
      decodeDevHmuxStandaloneOperation(
        Buffer.concat([valid, Buffer.from([0])]),
        request,
      ),
    ).toThrow(/response frame/);
    const invalidUtf8 = Buffer.from([0, 0, 0, 1, 0xff]);
    expect(() => decodeDevHmuxStandaloneOperation(invalidUtf8, request)).toThrow(
      /response JSON/,
    );
  });
});
