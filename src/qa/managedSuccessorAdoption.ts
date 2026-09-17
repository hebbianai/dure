import { installAgentRuntimeProjectionReconciliationRuntime } from "@/lib/agents/agentRuntimeProjectionReconciliationRuntime";
import { publishHmuxControlPlaneCensus } from "@/lib/hmux/identity/hmuxControlPlaneCensusFeed";
import { sameHmuxManagedGeneration } from "@/lib/hmux/identity/hmuxManagedGeneration";
import { hmux } from "@/lib/ipc";
import { convertFileSrc } from "@/lib/ipc/core";
import { createDureAgentRuntimeClient } from "@/lib/ipc/dureAgentRuntime";
import { readFile, writeFile } from "@/lib/ipc/files";
import { homeDir } from "@/lib/ipc/git";
import { qaLog } from "@/lib/qa/qaLog";
import { hmuxManagedBinding } from "@/lib/terminal/terminalBinding";
import { durableAppStorage, useStore } from "@/store";
import { managedAgentFixture } from "@/test/agentFixtures";

const delay = () => new Promise<void>((resolve) => setTimeout(resolve, 100));
async function waitFor(description: string, ready: () => Promise<boolean>) {
	const deadline = Date.now() + 30_000;
	while (!(await ready())) {
		if (Date.now() >= deadline) throw new Error(`Timed out: ${description}`);
		await delay();
	}
}

/** Real disposable Host/PTY and backend requests. The client rehosts the owned
 * provider fixture before this hidden WebView starts the production reconciler. */
export async function runManagedSuccessorAdoptionProbe(): Promise<void> {
	const proof = new URLSearchParams(location.search).get(
		"qaManagedSuccessorAdoption",
	);
	if (!import.meta.env.DEV || !proof) return;
	const home = await homeDir();
	if (!/\/dure-managed-successor-adoption\.[^/]+\/home$/.test(home)) {
		throw new Error("Successor probe requires its disposable QA home");
	}
	const agentId = `qa-successor-${proof}`;
	const conversationId = crypto.randomUUID();
	const ensures: string[] = [];
	const failures: string[] = [];
	const originalWarn = console.warn;
	console.warn = (...args: Parameters<typeof console.warn>) => {
		if (args[0] === "[agent runtime projection reconciliation]") {
			failures.push(
				args[1] instanceof Error ? args[1].message : String(args[1]),
			);
		}
		originalWarn.apply(console, args);
	};
	const originalFetch = window.fetch;
	const endpoint = convertFileSrc("dure_backend_request", "ipc");
	// Observe only this fixture's checkpoint target; forward every native call.
	window.fetch = async (
		...args: Parameters<typeof fetch>
	): Promise<Response> => {
		if (String(args[0]) === endpoint) {
			const request = JSON.parse(String(args[1]?.body));
			if (
				request.operation === "agent_checkpoint.binding.ensure" &&
				request.body?.agentId === agentId
			) {
				ensures.push(request.body.sessionId);
			}
		}
		return originalFetch.apply(window, args);
	};
	let stop: (() => void) | undefined;
	const observations: Record<string, unknown> = {};
	let result: Record<string, unknown>;
	try {
		const created = await hmux.advanceManagedCreate({
			idempotencyKey: agentId,
			sessionId: agentId,
			workspaceId: `workspace-${proof}`,
			providerId: "codex",
			conversationId,
			permissionMode: "default",
			cwd: `${home}/successor-project`,
			command: `codex resume ${conversationId}`,
			columns: 80,
			rows: 24,
			terminalDefaultColors: { foregroundRgb: 0xffffff, backgroundRgb: 0 },
		});
		if (created.state !== "current" || created.receipt.outcome !== "created")
			throw new Error("Expected a new owned source");
		const source = created.receipt.session;
		const cwd = created.receipt.cwd;
		if (!cwd) throw new Error("Missing canonical launch directory");
		observations.source = source.sessionId;
		await waitFor("owned source provider started", async () => {
			try {
				return (
					(await readFile(`${home}/provider-starts`)).content === "started\n"
				);
			} catch {
				return false;
			}
		});
		await writeFile(
			`${home}/successor-source.json`,
			JSON.stringify({
				proof,
				sessionId: source.sessionId,
				workspaceId: source.workspaceId,
				conversationId,
			}),
		);
		let targetId = "";
		await waitFor("owned CLI rehost completed", async () => {
			let file: Awaited<ReturnType<typeof readFile>>;
			try {
				file = await readFile(`${home}/successor-target.json`);
			} catch {
				return false;
			}
			if (file.truncated) throw new Error("Truncated target receipt");
			const target = JSON.parse(file.content);
			if (target.proof !== proof || typeof target.sessionId !== "string")
				throw new Error("Wrong target receipt");
			targetId = target.sessionId;
			return true;
		});
		const census = await hmux.controlPlaneCensus();
		const predecessor = census.sessions.find(
			(session) => session.sessionId === source.sessionId,
		);
		const target = census.sessions.find(
			(session) => session.sessionId === targetId,
		);
		if (
			predecessor?.lifecycle !== "exited" ||
			target?.lifecycle !== "ready" ||
			!target.stopFence
		)
			throw new Error("Expected exited source and ready real successor");
		observations.target = targetId;
		const binding = hmuxManagedBinding(
			source.sessionId,
			source.workspaceId,
			undefined,
			undefined,
			source.stopFence,
			"local",
		);
		binding.createIdempotencyKey = created.receipt.idempotencyKey;
		useStore.setState({
			agents: [
				managedAgentFixture({
					id: agentId,
					name: agentId,
					projectId: "qa-project",
					sessionId: source.sessionId,
					conversationId,
					worktreePath: cwd,
					runtimeBinding: binding,
				}),
			],
			projects: [
				{
					id: "qa-project",
					name: "Successor QA",
					path: cwd,
					kind: "local",
					isRepo: false,
				},
			],
			accounts: [],
			layouts: {},
		});
		const client = createDureAgentRuntimeClient({ profileId: "local" });
		const initial = await client.inspect(agentId);
		if (initial.state !== "unmanaged")
			throw new Error("Backend must initially be unmanaged");
		observations.initialBackend = initial.state;
		stop = installAgentRuntimeProjectionReconciliationRuntime().stop;
		publishHmuxControlPlaneCensus(census);
		await waitFor(
			"startup successor projection",
			async () => useStore.getState().agents[0]?.sessionId === targetId,
		);
		const adopted = await client.inspect(agentId);
		if (
			adopted.state !== "stable" ||
			adopted.interactionProfile !== "native_cli" ||
			adopted.sessionId !== targetId ||
			!sameHmuxManagedGeneration(adopted.stopFence, target.stopFence)
		)
			throw new Error("Backend did not adopt exact final generation");
		const current = useStore.getState().agents[0];
		if (
			current.conversationId !== conversationId ||
			current.runtimeBinding?.runtime !== "hmux_managed_v1" ||
			!sameHmuxManagedGeneration(
				current.runtimeBinding?.stopFence,
				target.stopFence,
			)
		)
			throw new Error("Conversation or pane fence changed");
		publishHmuxControlPlaneCensus(await hmux.controlPlaneCensus());
		await durableAppStorage.flush();
		const after = (await hmux.controlPlaneCensus()).sessions.find(
			(session) => session.sessionId === targetId,
		);
		if (
			!sameHmuxManagedGeneration(after?.stopFence, target.stopFence) ||
			after?.lifecycle !== "ready"
		)
			throw new Error("Adoption replaced the provider generation");
		if (ensures.length !== 1 || ensures[0] !== targetId)
			throw new Error(
				`Unexpected checkpoint targets: ${JSON.stringify(ensures)}`,
			);
		result = {
			proof,
			result: "passed",
			...observations,
			ensures,
			backend: adopted.state,
			sameGeneration: true,
		};
	} catch (error) {
		result = {
			proof,
			result: "failed",
			failures,
			...observations,
			ensures,
			error: String(error),
		};
	} finally {
		stop?.();
		window.fetch = originalFetch;
		console.warn = originalWarn;
	}
	qaLog("managed-successor-adoption", result);
	await writeFile(`${home}/successor-result.json`, JSON.stringify(result));
}
