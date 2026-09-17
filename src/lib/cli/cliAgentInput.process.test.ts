// @vitest-environment jsdom
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDockview } from "dockview-react";
import {
	registerDockview,
	unregisterDockview,
} from "@/lib/workspace/dock/dockRegistry";
import { useStore } from "@/store";
import { managedAgentFixture } from "@/test/agentFixtures";
import {
	type CliAgentInputRouting,
	handleCliAgentInput,
} from "./cliAgentInput";

const mocks = vi.hoisted(() => ({ send: vi.fn(), claim: vi.fn() }));
vi.mock("@/lib/agents/chat/agentChatSessionRuntime", () => ({
	sendAgentChatMessage: mocks.send,
}));
vi.mock("@/lib/cli/cliRequestBroker", () => ({
	claimCliRequest: mocks.claim,
}));
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const stop of cleanup.splice(0).reverse()) await stop();
});
const profile = {
	schemaVersion: 1 as const,
	kind: "structured_protocol" as const,
	backendProfileId: "local",
	interactionSessionId: "interaction-process",
};

it.each([
	...[
		"agent:process-chat",
		"pane:process-slot",
		"launcher:previous",
		"agent:previous",
	].flatMap((paneId) =>
		[false, true].flatMap((replaced) =>
			[false, true].map((enter) => ({
				paneId,
				replaced,
				enter,
				mounted: true,
			})),
		),
	),
	...[false, true].map((replaced) => ({
		paneId: "pane:unmounted",
		replaced,
		enter: true,
		mounted: false,
	})),
])(
	"runs the real CLI through HTTP and production input handlers ($paneId, replaced=$replaced, enter=$enter)",
	async ({ paneId, replaced, enter, mounted }) => {
		mocks.send.mockReset().mockResolvedValue({ delivery: "sent" });
		mocks.claim.mockReset().mockResolvedValue(true);
		const beforeState = useStore.getState();
		cleanup.push(async () => {
			useStore.setState(beforeState, true);
		});
		const root = await mkdtemp(join(tmpdir(), "dure-chat-input-process-"));
		cleanup.push(async () => {
			if (!root.startsWith(join(tmpdir(), "dure-chat-input-process-")))
				throw new Error("unowned fixture root");
			await rm(root, { recursive: true, force: true });
		});
		const agent = managedAgentFixture({
			id: "process-chat",
			name: "worker",
			sessionId: "process-session",
			runtimeBinding: undefined,
			interactionProfile: profile,
		});
		useStore.setState({
			agents: [
				replaced
					? {
							...agent,
							interactionProfile: {
								...profile,
								interactionSessionId: "replacement",
							},
						}
					: agent,
			],
			projects: [],
			chatDrafts: {},
		});
		const owner = {
			schemaVersion: 1 as const,
			paneId,
			desktopId: "chat-space",
			dockviewId: "dock-2",
			windowLabel: "win-100-2",
			windowGeneration: "generation-2",
		};
		const element = document.createElement("div");
		document.body.append(element);
		const api = createDockview(element, {
			createComponent: () => ({
				element: document.createElement("div"),
				init() {},
				dispose() {},
			}),
		});
		api.layout(800, 600);
		if (mounted) {
			api.addPanel({
				id: paneId,
				component: "agent",
				params: { agentRef: { agentId: agent.id } },
			});
			registerDockview(owner.desktopId, api);
		}
		useStore.setState({
			spaces: mounted ? [{ id: owner.desktopId, name: "Chat" }] : [],
			layouts: mounted ? { [owner.desktopId]: api.toJSON() } : {},
		});
		if (enter)
			useStore
				.getState()
				.updateChatDraft({ agentId: agent.id, ...profile }, () => ({
					text: "Keep the unsent draft",
					attachments: [],
				}));
		const draftsBefore = useStore.getState().chatDrafts;
		cleanup.push(async () => {
			unregisterDockview(owner.desktopId, api);
			api.dispose();
			element.remove();
		});
		const claims: string[] = [];
		const destination: CliAgentInputRouting = {
			currentWindowLabel: () => owner.windowLabel,
			resolve: async () => {
				throw new Error("forwarded input must retain its owner");
			},
			revalidate: (candidate) => {
				expect(candidate).toEqual(owner);
			},
			forward: async () => {
				throw new Error("duplicate forward");
			},
			claim: async (id) => {
				claims.push(`destination:${id}`);
				return true;
			},
		};
		let forwardedResult: Awaited<ReturnType<typeof handleCliAgentInput>> = null;
		const source: CliAgentInputRouting = {
			currentWindowLabel: () => "main",
			resolve: async () => {
				if (enter)
					throw new Error("submitted input must not depend on pane discovery");
				return owner;
			},
			revalidate: () => {
				throw new Error("source must not append remotely owned input");
			},
			forward: async (_label, request) => {
				expect(useStore.getState().chatDrafts).toEqual({});
				forwardedResult = await handleCliAgentInput(
					request.params,
					request.reqId,
					destination,
				);
			},
			claim: async (id) => {
				claims.push(`source:${id}`);
				return true;
			},
		};
		let requestCount = 0;
		const requests: Record<string, unknown>[] = [];
		const server = createServer(async (request, response) => {
			try {
				expect(request.url).toBe("/agent/input");
				expect(request.headers.authorization).toBe("Bearer fixture-token");
				let body = "";
				for await (const chunk of request) body += chunk;
				requestCount += 1;
				const params = JSON.parse(body);
				requests.push(params);
				const result =
					(await handleCliAgentInput(params, "process-request", source)) ??
					forwardedResult;
				response.writeHead(result?.ok ? 200 : 409, {
					"Content-Type": "application/json",
				});
				response.end(JSON.stringify(result));
			} catch (error) {
				response.writeHead(500, { "Content-Type": "application/json" });
				response.end(
					JSON.stringify({ ok: false, error: { message: String(error) } }),
				);
			}
		});
		await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
		cleanup.push(
			() =>
				new Promise<void>((accept, reject) =>
					server.close((error) => (error ? reject(error) : accept())),
				),
		);
		const address = server.address();
		if (!address || typeof address === "string")
			throw new Error("fixture server has no TCP port");
		await writeFile(
			join(root, "server.json"),
			JSON.stringify({ port: address.port, token: "fixture-token" }),
			{ mode: 0o600 },
		);
		await mkdir(join(root, "discovery"));
		await writeFile(
			join(root, "agents.json"),
			JSON.stringify({
				version: 3,
				projects: [],
				agents: [
					{
						id: agent.id,
						name: "worker",
						project: "fixture",
						sessionId: agent.sessionId,
						interactionProfile: profile,
					},
				],
			}),
			{ mode: 0o600 },
		);
		const text = "  한글 캡처\n기존 입력과 합쳐 검토해 주세요.\n";
		const result = await new Promise<{
			code: number | null;
			stdout: string;
			stderr: string;
		}>((accept, reject) => {
			const child = spawn(
				process.execPath,
				[
					resolve("cli/dure.mjs"),
					"send",
					"worker",
					"--stdin",
					...(enter ? [] : ["--no-enter"]),
					"--json",
					"--idempotency-key",
					"process-input-1",
				],
				{
					env: {
						PATH: process.env.PATH,
						HOME: root,
						DURE_HOME: root,
						DURE_APP_CHANNEL: "stable",
						HMUX_DISCOVERY_ROOT: join(root, "discovery"),
						DURE_HMUX_BIN: join(root, "no-hmux"),
					},
					stdio: ["pipe", "pipe", "pipe"],
					timeout: 4_000,
				},
			);
			let stdout = "",
				stderr = "";
			let processError: Error | undefined;
			child.stdout.on("data", (chunk) => {
				stdout += chunk;
			});
			child.stderr.on("data", (chunk) => {
				stderr += chunk;
			});
			child.on("error", (error) => {
				processError = error;
			});
			child.stdin.on("error", (error) => {
				processError = error;
			});
			child.on("close", (code) =>
				processError ? reject(processError) : accept({ code, stdout, stderr }),
			);
			child.stdin.end(text);
		});
		expect(requestCount).toBe(1);
		expect(requests[0]).not.toHaveProperty("targetPanelId");
		if (enter) {
			expect(mocks.claim).toHaveBeenCalledExactlyOnceWith("process-request");
			expect(forwardedResult).toBeNull();
			expect(claims).toEqual([]);
			expect(useStore.getState().chatDrafts).toBe(draftsBefore);
		} else expect(mocks.send).not.toHaveBeenCalled();
		if (replaced) {
			expect(result.code).not.toBe(0);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain("recipient changed");
			expect(useStore.getState().chatDrafts).toBe(draftsBefore);
			expect(mocks.send).not.toHaveBeenCalled();
			if (!enter) expect(claims).toEqual(["source:process-request"]);
		} else if (enter) {
			expect(result).toMatchObject({ code: 0, stderr: "" });
			expect(JSON.parse(result.stdout)).toEqual({
				apiVersion: "dure.send/v1",
				ok: true,
				target: { agentId: agent.id, sessionId: profile.interactionSessionId },
				receipt: { kind: "structured_chat", delivery: "sent" },
			});
			expect(mocks.send).toHaveBeenCalledExactlyOnceWith({
				agentId: agent.id,
				profile,
				text,
			});
		} else {
			expect(forwardedResult).toMatchObject({
				ok: true,
				input: { panelId: paneId, agentId: agent.id },
			});
			expect(result).toMatchObject({ code: 0, stderr: "" });
			expect(JSON.parse(result.stdout)).toMatchObject({
				ok: true,
				target: { agentId: agent.id, sessionId: profile.interactionSessionId },
				receipt: { kind: "structured_chat", delivery: "drafted" },
			});
			expect(
				Object.values(useStore.getState().chatDrafts[agent.id])[0].text,
			).toBe(text);
			expect(claims).toEqual(["destination:process-request"]);
		}
	},
);
