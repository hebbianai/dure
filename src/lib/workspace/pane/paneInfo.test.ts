import { describe, expect, it } from "vitest";

import {
	buildPaneInfoModel,
	resolvePaneInfoExecutionLocation,
} from "@/lib/workspace/pane/paneInfo";

describe("buildPaneInfoModel", () => {
	it("projects detailed remote runtime identity without transport or credential data", () => {
		const model = buildPaneInfoModel({
			paneId: "agent:remote",
			component: "agent",
			title: "Remote agent",
			spaceId: "space-1",
			pinned: true,
			executionLocation: { kind: "ssh", target: "build-host" },
			binding: {
				schemaVersion: 1,
				runtime: "hmux_managed_v1",
				source: "ssh",
				hostId: "host-1",
				sessionId: "session-1",
				workspaceId: "workspace-1",
				createIdempotencyKey: "create-secret-adjacent",
				commandBridgeNonce: "never-show-this-nonce",
				credentialId: "credential-private",
				credentialProfileDirectory: ".dure/accounts/private",
			},
			sessionMetadata: {
				sessionId: "session-1",
				workspaceId: "workspace-1",
				sessionClass: "managed",
				lifecycle: "ready",
				health: "current_healthy",
				terminalEpoch: "epoch-1",
				outputSeq: "7",
				capabilities: ["terminal_io_v1"],
			},
		});

		const serialized = JSON.stringify(model);
		expect(serialized).toContain('"key":"spaceId","value":"space-1"');
		expect(serialized).not.toContain("desktopId");
		expect(serialized).toContain("session-1");
		expect(serialized).toContain("workspace-1");
		expect(serialized).toContain("build-host");
		expect(serialized).not.toContain("never-show-this-nonce");
		expect(serialized).not.toContain("credential-private");
		expect(serialized).not.toContain("create-secret-adjacent");
		expect(serialized).not.toContain(".dure/accounts/private");
	});
	it.each(["slot", "agent:previous", "term:previous", "launcher:previous"])(
		"reports the actual content in %s",
		(paneId) => {
			for (const [component, kind] of [
				["agent", "agent"],
				["terminal", "terminal"],
				["browser", "browser"],
				["fileviewer", "file"],
				["githubissue", "github"],
			]) {
				const fields = buildPaneInfoModel({
					paneId,
					component,
					title: "Pane",
					pinned: false,
					executionLocation: { kind: "local" },
				}).sections.flatMap((section) => section.fields);
				expect(fields.find((field) => field.key === "paneKind")?.value).toBe(
					kind,
				);
				expect(fields.find((field) => field.key === "paneId")?.value).toBe(
					paneId,
				);
			}
		},
	);
});

describe("resolvePaneInfoExecutionLocation", () => {
	const observed = { kind: "local" } as const;

	it("lets an SSH Agent's session kind decide before anything the shell reports", () => {
		expect(
			resolvePaneInfoExecutionLocation({
				agentProfile: {
					locationOverride: (host) => ({ kind: "ssh", target: host ?? "ssh" }),
				},
				agentSshHostName: "build-mac",
				nestedSsh: { kind: "ssh", target: "user@elsewhere" },
				component: "agent",
				observed,
			}),
		).toEqual({ kind: "ssh", target: "build-mac" });
	});

	it("reports a shell nested inside an SSH session as that session", () => {
		expect(
			resolvePaneInfoExecutionLocation({
				agentProfile: { locationOverride: () => undefined },
				nestedSsh: { kind: "ssh", target: "user@host" },
				component: "terminal",
				observed,
			}),
		).toEqual({ kind: "ssh", target: "user@host" });
	});

	it("names the best host an SSH pane knows, down to the runtime's own word", () => {
		expect(
			resolvePaneInfoExecutionLocation({
				component: "ssh",
				sshHostName: "Build Mac",
				paramsHostId: "host-1",
				observed,
			}),
		).toEqual({ kind: "ssh", target: "Build Mac" });
		expect(
			resolvePaneInfoExecutionLocation({
				component: "ssh",
				paramsHostId: "host-1",
				observed,
			}),
		).toEqual({ kind: "ssh", target: "host-1" });
		expect(
			resolvePaneInfoExecutionLocation({ component: "ssh", observed }),
		).toEqual({ kind: "ssh", target: "ssh" });
	});

	it("reports what the terminal observed for a local shell", () => {
		expect(
			resolvePaneInfoExecutionLocation({
				component: "terminal",
				observed: { kind: "unknown" },
			}),
		).toEqual({ kind: "unknown" });
	});
});
