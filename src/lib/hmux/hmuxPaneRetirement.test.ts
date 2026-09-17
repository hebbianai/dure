import { describe, expect, it, vi } from "vitest";
import {
  departHmuxPaneExplicitly,
  departRemoteHmuxPaneExplicitly,
  hmuxPaneOwnerId,
  planExplicitHmuxPaneDeparture,
  planExplicitRemoteHmuxPaneDeparture,
} from "@/lib/hmux/hmuxPaneRetirement";
import { hmux } from "@/lib/ipc";
import {
  hmuxManagedBinding,
  hmuxStandaloneBinding,
  remoteHmuxStandaloneBinding,
	type TerminalPaneBindingV1,
} from "@/lib/terminal/terminalBinding";

const legacyLocalBinding = (sessionId: string) =>
	({
		schemaVersion: 1,
		runtime: "legacy_session_v1",
		source: "local",
		hostId: "local",
		sessionId,
	}) as unknown as TerminalPaneBindingV1;

const mocks = vi.hoisted(() => ({
  resolveRemote: vi.fn(),
  remoteDepart: vi.fn(),
}));

vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  remoteHmuxDepartGracefully: mocks.remoteDepart,
}));

vi.mock("@/lib/hmux/remote/remoteHmuxControllerResolution", () => ({
  resolveRemoteHmuxStandaloneController: mocks.resolveRemote,
}));

describe("explicit Hmux pane departure", () => {
  it("uses the same window, desktop, and pane owner identity as TerminalView", () => {
    expect(hmuxPaneOwnerId("main", "desk-1", "term:session-1")).toBe(
      "window:main:desktop:desk-1:pane:term:session-1",
    );
  });

  it("authorizes only standalone pane bindings", () => {
    const common = {
      windowLabel: "main",
      desktopId: "desk-1",
      panelId: "term:session-1",
    };
    expect(
      planExplicitHmuxPaneDeparture({
        ...common,
        binding: hmuxStandaloneBinding("session-1", "workspace-1"),
      }),
    ).toEqual({
      ownerId: "window:main:desktop:desk-1:pane:term:session-1",
      sessionId: "session-1",
      workspaceId: "workspace-1",
    });
    expect(
      planExplicitHmuxPaneDeparture({
        ...common,
        binding: hmuxManagedBinding("session-1", "workspace-1"),
      }),
    ).toBeNull();
    expect(
      planExplicitHmuxPaneDeparture({
        ...common,
        binding: remoteHmuxStandaloneBinding(
          "session-1",
          "workspace-1",
          "host-1",
          "nonce-1",
        ),
      }),
    ).toBeNull();
    expect(
      planExplicitHmuxPaneDeparture({
        ...common,
        binding: legacyLocalBinding("session-1"),
      }),
    ).toBeNull();
  });

  it("keeps remote authority bound to the pane owner and exact SSH binding", () => {
    const binding = remoteHmuxStandaloneBinding(
      "session-1",
      "workspace-1",
      "host-1",
      "nonce-1",
    );
    expect(
      planExplicitRemoteHmuxPaneDeparture({
        windowLabel: "main",
        desktopId: "desk-1",
        panelId: "term:session-1",
        binding,
      }),
    ).toEqual({
      ownerId: "window:main:desktop:desk-1:pane:term:session-1",
      binding,
    });
  });

  it("projects an explicit remote departure through the exact resolved fence", async () => {
    const binding = remoteHmuxStandaloneBinding(
      "session-1",
      "workspace-1",
      "host-1",
      "nonce-1",
    );
    const target = { hostId: "host-1" };
    const session = {
      sessionId: "session-1",
      workspaceId: "workspace-1",
    };
    mocks.resolveRemote.mockResolvedValueOnce({ target, session });
    mocks.remoteDepart.mockResolvedValueOnce({
      state: "retirement_armed",
    });

    await expect(
      departRemoteHmuxPaneExplicitly(
        { ownerId: "pane-owner", binding },
        [],
      ),
    ).resolves.toEqual({ state: "retirement_armed" });
    expect(mocks.remoteDepart).toHaveBeenCalledWith(
      target,
      session,
      "pane-owner",
    );
  });

  it("preserves the session when the typed departure transport is unavailable", async () => {
    vi.spyOn(hmux, "departPaneGracefully").mockRejectedValueOnce(new Error("old sidecar"));
    await expect(
      departHmuxPaneExplicitly({
        ownerId: "owner",
        sessionId: "session",
        workspaceId: "workspace",
      }),
    ).resolves.toEqual({
      state: "session_preserved",
      reason: "transport_unavailable",
    });
  });

  it("abandons a just-created Host when close wins before native attachment", async () => {
    vi.spyOn(hmux, "departPaneGracefully").mockResolvedValueOnce({
      state: "session_preserved",
      reason: "not_attached",
    });
    const abandon = vi
      .spyOn(hmux, "abandonUnpresentedCreation")
      .mockResolvedValueOnce({ state: "retirement_armed" });

    await expect(
      departHmuxPaneExplicitly({
        ownerId: "owner",
        sessionId: "session",
        workspaceId: "workspace",
      }),
    ).resolves.toEqual({ state: "retirement_armed" });
    expect(abandon).toHaveBeenCalledWith("session", "workspace");
  });
});
