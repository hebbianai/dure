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
