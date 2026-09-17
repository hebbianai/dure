import {
	agentRemovalDialogSnapshot,
	closeAgentRemovalDialog,
	openAgentRemovalDialog,
} from "@/lib/agents/agentRemovalDialog";
import { registerAgentDurably } from "@/lib/agents/durableAgentRegistration";
import { t } from "@/lib/i18n";
import { readFile, writeFile } from "@/lib/ipc/files";
import { homeDir } from "@/lib/ipc/git";
import { hmux } from "@/lib/ipc/hmux";
import { ensureQaLocalProject } from "@/lib/qa/qaLocalProject";
import { mountedDockviewEntries } from "@/lib/workspace/dock/dockRegistry";
import {
	type AgentRemovalPaneStopProbe,
	probeAgentRemovalPaneStop,
} from "@/qa/agentRemovalPaneStop";
import { useStore } from "@/store";
import type { Agent } from "@/types";

const delay = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(
	label: string,
	read: () => T | undefined | Promise<T | undefined>,
): Promise<T> {
	const deadline = performance.now() + 20_000;
	while (performance.now() < deadline) {
		const value = await read();
		if (value !== undefined) return value;
		await delay(25);
	}
	throw new Error(`Agent removal QA timed out: ${label}`);
}

/** The fixture drives the real dialog; every IPC still reaches the native owner. */
export async function runAgentRemovalQa(serialized: string): Promise<void> {
	const fixture = JSON.parse(serialized) as {
		runId: string;
		home: string;
		repo: string;
	};
	const home = (await homeDir()).replace(/\/$/, "");
	if (
		!import.meta.env.DEV ||
		fixture.runId !== import.meta.env.VITE_DURE_AGENT_REMOVAL_QA_RUN_ID ||
		fixture.home !== home ||
		!home.includes("/dure-agent-removal.") ||
		fixture.repo !== `${home}/repo`
	) {
		throw new Error("Agent removal QA escaped its disposable home");
	}
	const result: {
		runId: string;
		result: string;
		cases: object[];
		paneStops?: AgentRemovalPaneStopProbe[];
		error?: string;
	} = { runId: fixture.runId, result: "running", cases: [] };
	try {
		await waitFor("mounted workspace", () =>
			mountedDockviewEntries().length ? true : undefined,
		);
		const project = await ensureQaLocalProject(fixture.repo);
		const registeredProject = useStore
			.getState()
			.projects.find((value) => value.id === project.projectId);
		if (!registeredProject) throw new Error("QA project disappeared");
		const createAgent = async (
			name: string,
			worktree: string,
		): Promise<Agent> => {
			const session = await hmux.createStandalone({
				operationId: `qa-removal-${fixture.runId}-${name}`,
				cwd: worktree,
				columns: 80,
				rows: 24,
				commandLine: "exec /bin/cat",
				terminalDefaultColors: { foregroundRgb: 0xffffff, backgroundRgb: 0 },
			});
			if (
				session.sessionClass !== "standalone" ||
				session.lifecycle !== "ready"
			)
				throw new Error("QA standalone session was not ready");
			return {
				id: `agent-qa-${fixture.runId}-${name}`,
				name,
				provider: "codex",
				projectId: project.projectId,
				worktreePath: worktree,
				branch: worktree.split("/").pop() ?? name,
				sessionKind: "pty",
				sessionId: session.sessionId,
				started: true,
				runtimeBinding: {
					schemaVersion: 1,
					runtime: "hmux_standalone_v1",
					source: "local",
					hostId: "local",
					sessionId: session.sessionId,
					workspaceId: session.workspaceId,
				},
			};
		};
		for (const scenario of ["already-absent", "refresh", "new-user"] as const) {
			const worktree = `${fixture.repo}/.worktrees/${scenario}`;
			const agent = await registerAgentDurably(
				await createAgent(scenario, worktree),
				registeredProject,
			);
			const absentPeer = scenario === "already-absent"
				? await registerAgentDurably(await createAgent("absent-peer", worktree), registeredProject)
				: undefined;
			if (absentPeer) {
				await writeFile(`${home}/remove-fixture-worktree.json`, JSON.stringify({ runId: fixture.runId, worktree }));
				await waitFor("external fixture checkout removal", async () => {
					const receipt = await readFile(`${home}/fixture-worktree-removed.json`).catch(() => undefined);
					return receipt?.content === fixture.runId ? true : undefined;
				});
			}
			const newcomer =
				scenario === "new-user"
					? await createAgent("newcomer", worktree)
					: undefined;
			const refreshTimes: number[] = [];
			let refreshTimer: ReturnType<typeof setInterval> | undefined;
			try {
				openAgentRemovalDialog(agent);
				const dialog = await waitFor("Remove dialog", () =>
					[...document.querySelectorAll('[role="dialog"]')].find((value) =>
						value.textContent?.includes(t("common.removeAgent")),
					),
				);
				const toggle =
					dialog.querySelector<HTMLButtonElement>("#delete-worktree");
				if (!toggle) throw new Error("QA dedicated-worktree switch missing");
				toggle.click();
				await waitFor("checked worktree switch", () =>
					toggle.getAttribute("aria-checked") === "true" ? true : undefined,
				);
				const remove = [...dialog.querySelectorAll("button")].find(
					(value) => value.textContent === t("common.remove"),
				);
				if (!remove) throw new Error("QA Remove button missing");
				if (newcomer) await registerAgentDurably(newcomer, registeredProject);
				else if (scenario === "refresh") {
					// Fixture-only pressure overlaps the real Git shim's delayed reads.
					// The client proves this overlap from timestamps, not a sleep assumption.
					refreshTimer = setInterval(() => {
						refreshTimes.push(Date.now());
						useStore.setState((state) => ({
							agents: state.agents.map((value) => ({
								...value,
								displayName: `${value.name} refreshed ${refreshTimes.length}`,
							})),
							projects: state.projects.map((value) => ({ ...value })),
							sshHosts: state.sshHosts.map((value) => ({ ...value })),
						}));
					}, 20);
				}
				remove.click();
				const outcome = await waitFor("removal outcome", () => {
					if (
						dialog.textContent?.includes(
						t("agents.remove.confirmationUpdated"),
						)
					)
						return "scope-changed";
					if (
						[
							...dialog.querySelectorAll('[data-slot="dialog-footer"] button'),
						].some((value) => value.textContent === t("common.close"))
					)
						return "removed";
					const error = dialog.querySelector('[role="alert"]')?.textContent;
					if (error) throw new Error(error);
					return undefined;
				});
				const expected = newcomer ? "scope-changed" : "removed";
				result.cases.push({
					scenario,
					outcome,
					refreshTimes,
					agentId: agent.id,
					sessionId: agent.sessionId,
					workspaceId: agent.runtimeBinding?.workspaceId,
					newcomerSessionId: newcomer?.sessionId,
					absentPeerSessionId: absentPeer?.sessionId,
					worktree,
				});
				if (outcome !== expected) throw new Error(`${scenario}: ${outcome}`);
				if (absentPeer && !useStore.getState().agents.some((value) => value.id === absentPeer.id)) {
					throw new Error("Already-absent removal expanded to another Agent");
				}
				if (
					useStore.getState().agents.some((value) => value.id === agent.id) !==
					Boolean(newcomer)
				)
					throw new Error(
						"QA Agent projection did not match the removal outcome",
					);
			} finally {
				clearInterval(refreshTimer);
				const request = agentRemovalDialogSnapshot();
				if (request) closeAgentRemovalDialog(request.requestId);
			}
		}
		result.paneStops = [];
		await probeAgentRemovalPaneStop(
			fixture.runId,
			registeredProject,
			result.paneStops,
		);
		result.result = "passed";
	} catch (error) {
		result.result = "failed";
		result.error = String(error);
	} finally {
		await writeFile(
			`${home}/agent-removal-result.json`,
			JSON.stringify(result),
		);
	}
}
