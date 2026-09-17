import { describe, expect, it } from "vitest";
import {
  hmuxSessionConversionId,
  recoverConvertedStandaloneSourceBinding,
  selectHmuxConversionSourceBinding,
} from "@/lib/hmux/conversion/hmuxSessionConversionIdentity";
import {
  hmuxManagedBinding,
  hmuxStandaloneBinding,
} from "@/lib/terminal/terminalBinding";

const source = hmuxStandaloneBinding("standalone-source", "workspace-1");
const target = {
  ...hmuxManagedBinding("managed-target", "workspace-1"),
  createIdempotencyKey: "convert-1",
};
const managedShellSource = {
  ...hmuxManagedBinding(
    "term-zbO69IzS",
    "dure-local-shells-v1",
    undefined,
    undefined,
    {
      runnerPrincipal: "runner-source",
      runnerInstance: "instance-source",
      channelEpoch: "1",
      hostInstanceId: "host-source",
      terminalEpoch: "terminal-source",
    },
  ),
  createIdempotencyKey: "shell_term-zbO69IzS",
};

describe("Hmux session conversion identity", () => {
  it("derives a stable operation identity from the source pane fence", () => {
    const conversionId = hmuxSessionConversionId(
      "term:standalone-source",
      source,
      "managed",
    );
    expect(conversionId).toMatch(/^convert_[a-f0-9]{16}$/u);
    expect(
      hmuxSessionConversionId(
        "term:standalone-source",
        source,
        "managed",
      ),
    ).toBe(conversionId);
    expect(
      hmuxSessionConversionId(
        "term:another-pane",
        source,
        "managed",
      ),
    ).not.toBe(conversionId);
  });

  it("selects one exact source from mixed source/target consumers", () => {
    expect(
      selectHmuxConversionSourceBinding(
        [target, source, target],
        "managed",
        source.sessionId,
        source.workspaceId,
      ),
    ).toEqual(source);
  });

  it("selects a fenced managed local shell as the source of managed provider conversion", () => {
    const panelId = "term:managed-shell";
    const conversionId = hmuxSessionConversionId(
      panelId,
      managedShellSource,
      "managed",
    );
    const convertedTarget = {
      ...hmuxManagedBinding("managed-target", managedShellSource.workspaceId),
      createIdempotencyKey: conversionId,
    };
    expect(
      selectHmuxConversionSourceBinding(
        [convertedTarget, managedShellSource],
        "managed",
        managedShellSource.sessionId,
        managedShellSource.workspaceId,
        { id: panelId, component: "terminal" },
      ),
    ).toEqual(managedShellSource);

    expect(() =>
      selectHmuxConversionSourceBinding(
        [
          { ...convertedTarget, createIdempotencyKey: "unrelated-shell" },
          managedShellSource,
        ],
        "managed",
        managedShellSource.sessionId,
        managedShellSource.workspaceId,
        { id: panelId, component: "terminal" },
      ),
    ).toThrow(/consumers disagree/u);
  });

  it("treats the promoted managed Agent as a managed source on release", () => {
    expect(
      selectHmuxConversionSourceBinding(
        [managedShellSource],
        "standalone",
        managedShellSource.sessionId,
        managedShellSource.workspaceId,
        { id: "agent:promoted", component: "agent" },
      ),
    ).toEqual(managedShellSource);
  });

  it("reconstructs only a standalone source from one converged managed identity", () => {
    expect(
      recoverConvertedStandaloneSourceBinding(
        [target, target],
        source.sessionId,
        source.workspaceId,
      ),
    ).toEqual(source);
    expect(
      recoverConvertedStandaloneSourceBinding(
        [
          target,
          {
            ...target,
            sessionId: "other-target",
          },
        ],
        source.sessionId,
        source.workspaceId,
      ),
    ).toBeUndefined();
  });
});
