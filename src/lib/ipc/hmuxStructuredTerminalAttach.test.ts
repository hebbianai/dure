import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import { HmuxStructuredTerminalAttachError } from "@/lib/hmux/failure/structuredTerminalAttachFailure";
import { hmux } from "./hmux";

beforeEach(() => {
	mocks.invoke.mockReset();
});

describe("structured terminal attach IPC", () => {
	it("forwards the requested local surface access to the backend boundary", async () => {
		mocks.invoke.mockResolvedValueOnce({});

		await hmux.attachStructuredTerminal({
			observerId: "observer-local",
			surfaceId: "pane-local",
			sessionId: "session-local",
			workspaceId: "workspace-local",
			access: "read_only",
		});

		expect(mocks.invoke).toHaveBeenCalledWith(
			"hmux_structured_terminal_attach",
			expect.objectContaining({ access: "read_only" }),
		);
	});

	it("decodes the SSH attach lane through the shared typed failure contract", async () => {
		mocks.invoke.mockRejectedValueOnce({
			code: "hmux_transport_closed",
			message: "remote Host retired the viewport attachment",
			retryDirective: "reconnect",
		});

		const attaching = hmux.attachRemoteStructuredTerminal({
			observerId: "observer-remote",
			surfaceId: "pane-remote",
			access: "read_only",
			target: {
				schemaVersion: 1,
				hostId: "host-remote",
				host: "remote.example",
				port: 22,
				user: "developer",
				auth: "key",
				keyPath: "/keys/remote",
				hostKeyFingerprints: ["SHA256:remote"],
			},
			session: {
				sessionId: "session-remote",
				workspaceId: "workspace-remote",
				sessionClass: "managed",
				lifecycle: "ready",
				providerId: "codex",
				runnerPrincipal: "runner",
				runnerInstance: "runner-1",
				channelEpoch: "1",
				hostInstanceId: "host-instance-1",
				terminalEpoch: "terminal-1",
				supportedProtocol: {
					minimum: { major: 1, minor: 0 },
					maximum: { major: 1, minor: 0 },
				},
				capabilities: ["terminal_state_binary_v1"],
			},
		});

		await expect(attaching).rejects.toBeInstanceOf(
			HmuxStructuredTerminalAttachError,
		);
		await expect(attaching).rejects.toMatchObject({
			code: "hmux_transport_closed",
			retryDirective: "reconnect",
		});
		expect(mocks.invoke).toHaveBeenCalledTimes(1);
		expect(mocks.invoke).toHaveBeenCalledWith(
			"remote_hmux_structured_terminal_attach",
			expect.objectContaining({
				request: expect.objectContaining({ access: "read_only" }),
			}),
		);
	});
});
