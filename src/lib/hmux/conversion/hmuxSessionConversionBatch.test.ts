import { describe, expect, it, vi } from "vitest";
import {
  runHmuxSessionConversionBatch,
  type HmuxSessionConversionBatchItem,
} from "@/lib/hmux/conversion/hmuxSessionConversionBatch";
import type {
  HmuxSessionConversionPaneReceipt,
  HmuxSessionConversionInspection,
} from "@/lib/hmux/conversion/hmuxSessionConversion";
import type { PreparedHmuxSessionConversion } from "@/lib/hmux/conversion/hmuxSessionConversionWorkflow";
import { hmuxStandaloneBinding } from "@/lib/terminal/terminalBinding";

function item(index: number): HmuxSessionConversionBatchItem {
  return {
    key: `term:source-${index}`,
    request: {
      sourceSessionId: `source-${index}`,
      sourceWorkspaceId: "workspace-1",
      panelId: `term:source-${index}`,
      target: "managed",
    },
  };
}

function prepared(
  input: HmuxSessionConversionBatchItem,
): PreparedHmuxSessionConversion {
  return {
    request: input.request,
    inspection: {
      desktopId: "desktop-1",
      panelId: input.request.panelId,
      resolvedPanelId: input.request.panelId,
      sourceBinding: hmuxStandaloneBinding(
        input.request.sourceSessionId,
        "workspace-1",
      ),
      target: "managed",
      providerId: "codex",
      cwd: "/repo",
      conversionId: `conversion:${input.key}`,
      permissionMode: "bypass_approvals",
      terminalEnvironment: {},
    } satisfies HmuxSessionConversionInspection,
  };
}

function receipt(index: number): HmuxSessionConversionPaneReceipt {
  return {
    desktopId: "desktop-1",
    panelId: `agent:target-${index}`,
    sessionId: `target-${index}`,
    workspaceId: "workspace-1",
    runtime: "hmux_managed_v1",
    providerId: "codex",
    conversationId: `conversation-${index}`,
    cwd: "/repo",
  };
}

describe("runHmuxSessionConversionBatch", () => {
  it("previews all candidates before one confirmation and commits serially", async () => {
    const items = [item(1), item(2)];
    const events: string[] = [];
    const prepare = vi.fn(async (request) => {
      events.push(`prepare:${request.panelId}`);
      const source = items.find(
        (candidate) => candidate.request.panelId === request.panelId,
      );
      if (!source) throw new Error("missing fixture");
      return prepared(source);
    });
    const confirm = vi.fn(async ({ message }) => {
      events.push("confirm");
      expect(message).toContain("2개");
      return true;
    });
    const commit = vi.fn(async (conversion) => {
      events.push(`commit:${conversion.request.panelId}`);
      return receipt(
        conversion.request.panelId === "term:source-1" ? 1 : 2,
      );
    });

    const result = await runHmuxSessionConversionBatch(
      items,
      0,
      confirm,
      { prepare, commit },
    );

    expect(result.converted).toHaveLength(2);
    expect(result.failures).toEqual([]);
    expect(events).toEqual([
      "prepare:term:source-1",
      "prepare:term:source-2",
      "confirm",
      "commit:term:source-1",
      "commit:term:source-2",
    ]);
  });

  it("keeps deferred and failed previews untouched while converting the rest", async () => {
    const items = [item(1), item(2)];
    const commit = vi.fn(async () => receipt(1));
    const confirm = vi.fn(async ({ message }) => {
      expect(message).toContain("2개 세션은 그대로");
      return true;
    });

    const result = await runHmuxSessionConversionBatch(
      items,
      1,
      confirm,
      {
        prepare: async (request) => {
          if (request.panelId === "term:source-2") {
            throw new Error("identity changed");
          }
          return prepared(items[0]);
        },
        commit,
      },
    );

    expect(result.deferredCount).toBe(2);
    expect(result.converted).toHaveLength(1);
    expect(result.failures).toHaveLength(1);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("never confirms or mutates when every preview fails", async () => {
    const confirm = vi.fn(async () => true);
    const commit = vi.fn();
    const result = await runHmuxSessionConversionBatch(
      [item(1)],
      0,
      confirm,
      {
        prepare: async () => {
          throw new Error("not ready");
        },
        commit,
      },
    );

    expect(result.accepted).toBe(false);
    expect(result.preparedCount).toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(confirm).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it("does not commit anything when the user declines the aggregate confirmation", async () => {
    const candidate = item(1);
    const commit = vi.fn();
    const result = await runHmuxSessionConversionBatch(
      [candidate],
      0,
      async () => false,
      {
        prepare: async () => prepared(candidate),
        commit,
      },
    );

    expect(result.accepted).toBe(false);
    expect(result.preparedCount).toBe(1);
    expect(commit).not.toHaveBeenCalled();
  });
});
