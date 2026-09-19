import { describe, expect, it } from "vitest";
import {
  planRemoteHmuxExitTransition,
  planRemoteHmuxManagedTransition,
} from "@/lib/hmux/remote/remoteHmuxRuntimeTransition";
import {
  acceptRemoteHmuxAttachReceipt,
  beginRemoteHmuxPaneTransition,
} from "@/lib/hmux/remote/remoteHmuxPaneTransition";
import {
  hmuxStandaloneBinding,
  remoteHmuxStandaloneBinding,
} from "@/lib/terminal/terminalBinding";

const source = hmuxStandaloneBinding("local-shell", "local-workspace");
const remote = remoteHmuxStandaloneBinding(
  "remote-shell",
  "remote-workspace",
  "host-rts",
  "bridge-1",
);
const transition = acceptRemoteHmuxAttachReceipt(
  beginRemoteHmuxPaneTransition(source, "host-rts", "create-1"),
  { createIdempotencyKey: "create-1", targetBinding: remote },
)!;
const marker = {
  schemaVersion: 1,
  event: "managed_started",
  bridgeNonce: "bridge-1",
  sourceSessionId: "remote-shell",
  sourceWorkspaceId: "remote-workspace",
  target: {
    sessionId: "managed-1",
    workspaceId: "managed-workspace",
    sessionClass: "managed",
    lifecycle: "ready",
    providerId: "claude",
    runnerPrincipal: "rts",
    runnerInstance: "runner-1",
    channelEpoch: "2",
    hostInstanceId: "host-1",
    terminalEpoch: "terminal-2",
  },
} as const;
const catalog = {
  ...marker.target,
  supportedProtocol: {
    minimum: { major: 1, minor: 0 },
    maximum: { major: 1, minor: 0 },
  },
  capabilities: ["terminal_input"],
};

describe("remote Hmux runtime transition", () => {
  it("accepts a command bridge from a directly opened SSH shell", () => {
    const managed = planRemoteHmuxManagedTransition(
      remote,
      undefined,
      marker,
      catalog,
    );
    expect(managed?.sessionId).toBe(marker.target.sessionId);
    expect(managed?.stopFence?.terminalEpoch).toBe(catalog.terminalEpoch);
  });

  it("restores a direct SSH shell only from its exact managed generation", () => {
    const managed = planRemoteHmuxManagedTransition(
      remote,
      undefined,
      marker,
      catalog,
    )!;
    const managedReturn = {
      schemaVersion: 1,
      sourceBinding: remote,
      targetBinding: managed,
    };
    expect(
      planRemoteHmuxExitTransition(managed, undefined, managedReturn),
    ).toEqual({ binding: remote, transition: undefined });
    for (const replaced of [
      { ...managed, sessionId: "another-session" },
      { ...managed, workspaceId: "another-workspace" },
      { ...managed, hostId: "another-host" },
      { ...managed, commandBridgeNonce: "another-bridge" },
      {
        ...managed,
        stopFence: { ...managed.stopFence!, terminalEpoch: "replacement" },
      },
    ]) {
      expect(
        planRemoteHmuxExitTransition(replaced, undefined, managedReturn),
      ).toBeUndefined();
    }
    expect(planRemoteHmuxExitTransition(remote, undefined)).toBeUndefined();
    expect(
      planRemoteHmuxExitTransition(managed, undefined, {
        ...managedReturn,
        sourceBinding: source,
      }),
    ).toBeUndefined();
    expect(
      planRemoteHmuxExitTransition(managed, undefined, {
        ...managedReturn,
        sourceBinding: { ...remote, commandBridgeNonce: "another-bridge" },
      }),
    ).toBeUndefined();
  });

  it("rejects forged markers and incomplete SSH handoffs on direct and converted panes", () => {
    for (const prior of [undefined, transition]) {
      for (const forged of [
        { ...marker, bridgeNonce: "forged" },
        { ...marker, sourceSessionId: "forged" },
        { ...marker, sourceWorkspaceId: "forged" },
      ]) {
        expect(
          planRemoteHmuxManagedTransition(remote, prior, forged, catalog),
        ).toBeUndefined();
      }
      expect(
        planRemoteHmuxManagedTransition(remote, prior, marker, {
          ...catalog,
          terminalEpoch: "replacement",
        }),
      ).toBeUndefined();
    }
    for (const invalid of [
      null,
      {},
      beginRemoteHmuxPaneTransition(source, "host-rts", "create-1"),
      { ...transition, targetBinding: { ...remote, sessionId: "other" } },
    ]) {
      expect(
        planRemoteHmuxManagedTransition(remote, invalid, marker, catalog),
      ).toBeUndefined();
    }
  });

  it("accepts a managed marker only with the exact source and live catalog fence", () => {
    const managed = planRemoteHmuxManagedTransition(
      remote,
      transition,
      marker,
      catalog,
    );
    expect(managed).toEqual({
      schemaVersion: 1,
      runtime: "hmux_managed_v1",
      source: "ssh",
      hostId: "host-rts",
      sessionId: "managed-1",
      workspaceId: "managed-workspace",
      createIdempotencyKey: "managed-1",
      commandBridgeNonce: "bridge-1",
      stopFence: {
        runnerPrincipal: "rts",
        runnerInstance: "runner-1",
        channelEpoch: "2",
        hostInstanceId: "host-1",
        terminalEpoch: "terminal-2",
      },
    });
    expect(
      planRemoteHmuxManagedTransition(
        remote,
        transition,
        { ...marker, bridgeNonce: "forged" },
        catalog,
      ),
    ).toBeUndefined();
    expect(
      planRemoteHmuxManagedTransition(remote, transition, marker, {
        ...catalog,
        terminalEpoch: "replacement",
      }),
    ).toBeUndefined();
  });

  it("restores remote shell after managed exit, then the local shell after remote exit", () => {
    const managed = planRemoteHmuxManagedTransition(
      remote,
      transition,
      marker,
      catalog,
    )!;
    expect(planRemoteHmuxExitTransition(managed, transition)).toEqual({
      binding: remote,
      transition,
    });
    expect(planRemoteHmuxExitTransition(remote, transition)).toEqual({
      binding: source,
      transition: undefined,
    });
  });

  it("does not retarget an unrelated pane", () => {
    expect(
      planRemoteHmuxExitTransition(
        remoteHmuxStandaloneBinding(
          "other",
          "other-workspace",
          "host-rts",
          "bridge-1",
        ),
        transition,
      ),
    ).toBeUndefined();
  });
});
