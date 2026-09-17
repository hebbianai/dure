import { describe, expect, it, vi } from "vitest";
import {
  runHmuxSessionConversionWorkflow,
  type HmuxSessionConversionWorkflowRequest,
} from "@/lib/hmux/conversion/hmuxSessionConversionWorkflow";
import type { HmuxSessionConversionInspection } from "@/lib/hmux/conversion/hmuxSessionConversion";
import type { HmuxSessionConversionReceipt } from "@/lib/ipc";
import { hmuxStandaloneBinding } from "@/lib/terminal/terminalBinding";

const request = {
  sourceSessionId: "standalone-source",
  sourceWorkspaceId: "workspace-1",
  panelId: "term:standalone-source",
  target: "managed",
} satisfies HmuxSessionConversionWorkflowRequest;

const inspection = {
  desktopId: "desktop-1",
  panelId: request.panelId,
  resolvedPanelId: request.panelId,
  sourceBinding: hmuxStandaloneBinding(
    request.sourceSessionId,
    request.sourceWorkspaceId,
  ),
  target: "managed",
  providerId: "codex",
  cwd: "/repo",
  conversionId: "conversion-1",
  permissionMode: "bypass_approvals",
  terminalEnvironment: {},
} satisfies HmuxSessionConversionInspection;

function conversionReceipt(
  confirmed: boolean,
): HmuxSessionConversionReceipt {
  return confirmed
    ? {
        sourceSessionId: request.sourceSessionId,
        sourceWorkspaceId: request.sourceWorkspaceId,
        targetClass: "managed",
        replacementIdempotencyKey: "conversion-1",
        action: "convert_standalone_to_managed_with_exact_conversation",
        outcome: "converted",
        replayed: false,
        requiresConfirmation: false,
        providerId: "codex",
        conversationId: "conversation-1",
        replacementSession: {
          sessionId: "managed-target",
          workspaceId: request.sourceWorkspaceId,
          sessionClass: "managed",
          lifecycle: "ready",
          terminalEpoch: "1",
          outputSeq: "0",
          capabilities: [],
        },
      }
    : {
        sourceSessionId: request.sourceSessionId,
        sourceWorkspaceId: request.sourceWorkspaceId,
        targetClass: "managed",
        action: "convert_standalone_to_managed_with_exact_conversation",
        outcome: "refused",
        replayed: false,
        reason: "update_requires_confirmation",
        requiresConfirmation: true,
        providerId: "codex",
        conversationId: "conversation-1",
      };
}

describe("runHmuxSessionConversionWorkflow", () => {
  it("does not execute a destructive conversion when confirmation is declined", async () => {
    const inspect = vi.fn(async () => inspection);
    const execute = vi.fn(async (_inspection, confirmed: boolean) =>
      conversionReceipt(confirmed),
    );
    const retarget = vi.fn();

    await expect(
      runHmuxSessionConversionWorkflow(
        request,
        async () => false,
        { inspect, execute, retarget },
      ),
    ).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(inspection, false);
    expect(retarget).not.toHaveBeenCalled();
  });

  it("retargets only after the confirmed replacement is healthy", async () => {
    const receipt = conversionReceipt(true);
    const execute = vi.fn(async (_inspection, confirmed: boolean) =>
      conversionReceipt(confirmed),
    );
    const paneReceipt = {
      desktopId: "desktop-1",
      panelId: "agent:promoted",
      sessionId: "managed-target",
      workspaceId: request.sourceWorkspaceId,
      runtime: "hmux_managed_v1",
      providerId: "codex",
      conversationId: "conversation-1",
      cwd: "/repo",
    } as const;
    const retarget = vi.fn(async () => paneReceipt);

    await expect(
      runHmuxSessionConversionWorkflow(
        request,
        async () => true,
        {
          inspect: async () => inspection,
          execute,
          retarget,
        },
      ),
    ).resolves.toEqual(paneReceipt);
    expect(execute.mock.calls.map((call) => call[1])).toEqual([false, true]);
    expect(retarget).toHaveBeenCalledWith(inspection, receipt);
  });

  it("rejects a malformed preview before confirmation or retarget", async () => {
    const confirm = vi.fn(async () => true);
    const retarget = vi.fn();

    await expect(
      runHmuxSessionConversionWorkflow(
        request,
        confirm,
        {
          inspect: async () => inspection,
          execute: async () => ({
            ...conversionReceipt(false),
            conversationId: undefined,
          }),
          retarget,
        },
      ),
    ).rejects.toThrow("update_requires_confirmation");
    expect(confirm).not.toHaveBeenCalled();
    expect(retarget).not.toHaveBeenCalled();
  });
});
