import { useAgentAttention } from "@/lib/agents/agentAttentionStore";
import type { AgentDisplayState } from "@/lib/agents/agentStateModel";
import { t } from "@/lib/i18n";
import { homeDir, readFile } from "@/lib/ipc";
import { qaLog } from "@/lib/qa/qaLog";
import { useWindowSidebarStore } from "@/lib/sidebar/windowSidebarStore";
import { getDockview } from "@/lib/workspace/dock/dockRegistry";
import { endedFoldKey, workGroupKey } from "@/lib/work/workViewList";
import { WORK_VIEW_DEFAULT } from "@/lib/work/workViewState";
import { useWorkViewStore } from "@/lib/work/workViewStore";
import { durableAppStorage, useStore } from "@/store";
import {
	agentFixture,
	managedBindingFixture,
	stopFenceFixture,
} from "@/test/agentFixtures";
import type { Agent, AgentActivity, Project } from "@/types";

/** Inside the real App in WKWebView: agents bound to sessions the disposable
 * discovery root never had meet the real main-window observer, which asks
 * the real census for a fresh look, so their exit and the Work view's Ended
 * folds come from the same path a person's machine takes. Live agents carry
 * a presentation lifecycle with no Host binding; one is starting, so its
 * state stays unknown. */

type Seat = "live" | "ended" | "starting";

interface SeededAgent {
	readonly id: string;
	readonly title: string;
	readonly project: string;
	readonly seat: Seat;
	readonly activity?: AgentActivity;
	readonly manager?: string;
	readonly provider?: Agent["provider"];
}

interface Scene {
	readonly name: "empty" | "few" | "many";
	readonly projects: readonly string[];
	readonly agents: readonly SeededAgent[];
	/** Ended folds this scene shows open. */
	readonly open?: readonly string[];
}

const live = (
	id: string,
	title: string,
	project: string,
	activity: AgentActivity,
	extra: Partial<SeededAgent> = {},
): SeededAgent => ({ id, title, project, seat: "live", activity, ...extra });
const ended = (
	id: string,
	title: string,
	project: string,
	extra: Partial<SeededAgent> = {},
): SeededAgent => ({ id, title, project, seat: "ended", ...extra });

const SCENES: readonly Scene[] = [
	{ name: "empty", projects: [], agents: [] },
	{
		name: "few",
		projects: ["dure", "api"],
		agents: [
			live("few-lead", "Ship the Work view", "dure", "working", {
				provider: "claude",
			}),
			ended("few-notes", "Write release notes", "dure"),
			live("few-login", "Fix the login redirect", "api", "waiting"),
			ended("few-migrate", "Migrate the sessions table", "api", {
				provider: "claude",
			}),
		],
	},
	{
		name: "many",
		projects: ["dure", "api", "docs", "website"],
		open: ["dure"],
		agents: [
			live("many-lead", "Lead the Work view batch", "dure", "working", {
				provider: "claude",
			}),
			live("many-search", "Add search to the Work list", "dure", "working", {
				manager: "many-lead",
			}),
			ended("many-fold", "Fold ended agents per project", "dure", {
				manager: "many-lead",
			}),
			ended("many-gc", "Explain the session GC", "dure", { provider: "claude" }),
			ended("many-zstd", "Read compressed rollouts", "dure"),
			ended("many-release", "Reconcile versions through v0.2.72", "dure", {
				provider: "claude",
			}),
			{
				id: "many-starting",
				title: "Profile the attach path",
				project: "dure",
				seat: "starting",
			},
			live("many-rate", "Rate-limit the public endpoints", "api", "waiting", {
				provider: "claude",
			}),
			ended("many-audit", "Audit the token refresh", "api"),
			ended("many-schema", "Generate the client schema", "api", {
				provider: "claude",
			}),
			ended("many-guide", "Rewrite the install guide", "docs"),
			ended("many-faq", "Answer the Windows questions", "docs", {
				provider: "claude",
			}),
			ended("many-lead-docs", "Restructure the reference", "docs", {
				provider: "claude",
			}),
			ended("many-ref-1", "Document the CLI flags", "docs", {
				manager: "many-lead-docs",
			}),
			ended("many-ref-2", "Document the config keys", "docs", {
				manager: "many-lead-docs",
			}),
			live("many-hero", "Tune the homepage hero", "website", "waiting", {
				provider: "claude",
			}),
		],
	},
];

const THEMES = ["light", "dark"] as const;

function check(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

async function waitFor(message: string, ready: () => boolean, timeoutMs = 60_000) {
	const deadline = performance.now() + timeoutMs;
	while (!ready()) {
		check(performance.now() < deadline, message);
		await new Promise((done) => setTimeout(done, 50));
	}
}

/** A condition that keeps holding: a durable rehydration or a late effect
 * can still undo what the probe just set. */
async function settle(message: string, ready: () => boolean, timeoutMs = 120_000) {
	const deadline = performance.now() + timeoutMs;
	let since: number | undefined;
	for (;;) {
		const now = performance.now();
		check(now < deadline, message);
		if (!ready()) since = undefined;
		else if (since === undefined) since = now;
		else if (now - since >= 800) return;
		await new Promise((done) => setTimeout(done, 50));
	}
}

function projectId(name: string): string {
	return `qa-work-${name}`;
}

function seed(scene: Scene, home: string) {
	const projects: Project[] = scene.projects.map((name) => ({
		id: projectId(name),
		name,
		path: `${home}/projects/${name}`,
		kind: "local",
		isRepo: false,
	}));
	const agents = scene.agents.map((entry) => {
		const sessionId = `qa-work-session-${entry.id}`;
		const manager = scene.agents.find((other) => other.id === entry.manager);
		return agentFixture({
			id: entry.id,
			name: entry.id,
			displayName: entry.title,
			provider: entry.provider ?? "codex",
			projectId: projectId(entry.project),
			worktreePath: `${home}/projects/${entry.project}`,
			branch: entry.id,
			sessionId,
			// A Host binding, with its published generation, to a session this
			// discovery root never had.
			...(entry.seat === "live"
				? {}
				: {
						runtimeBinding: managedBindingFixture({
							sessionId,
							workspaceId: "qa-work-workspace",
							createIdempotencyKey: `qa-work-create-${entry.id}`,
							stopFence: stopFenceFixture({
								terminalEpoch: `qa-work-terminal-${entry.id}`,
							}),
						}),
					}),
			...(manager ? { runParent: { agentId: manager.id } } : {}),
		});
	});
	const agentActivity: Record<string, AgentActivity> = {};
	for (const entry of scene.agents) {
		if (entry.activity) agentActivity[entry.id] = entry.activity;
		// A spawn this window recorded: the Host's not-found cannot prove an exit.
		if (entry.seat === "starting") agentActivity[entry.id] = "connecting";
	}
	useStore.setState({ projects, agents, agentActivity });
	useWorkViewStore.setState({
		...WORK_VIEW_DEFAULT,
		openFolds: (scene.open ?? []).map((name) =>
			endedFoldKey(workGroupKey("project", projectId(name))),
		),
	});
}

function expectedState(entry: SeededAgent): AgentDisplayState {
	if (entry.seat === "ended") return "exited";
	if (entry.seat === "starting") return "unknown";
	return entry.activity as AgentDisplayState;
}

function facts() {
	const list = document.querySelector('[data-slot="work-list"]');
	const folds = Array.from(list?.querySelectorAll("details") ?? []).map(
		(fold) => ({
			label: fold.querySelector("summary")?.textContent?.trim() ?? "",
			open: fold.open,
			section: fold
				.closest("section")
				?.querySelector("h3")
				?.textContent?.trim(),
		}),
	);
	const rows = Array.from(
		list?.querySelectorAll<HTMLElement>("[data-agent-row-key]") ?? [],
	).map((row) => ({
		key: row.dataset.agentRowKey,
		folded: Boolean(row.closest("details")),
		visible: row.getClientRects().length > 0,
	}));
	return {
		dark: document.documentElement.classList.contains("dark"),
		empty: list?.textContent?.includes(t("work.list.empty")) ?? false,
		folds,
		rows,
		displayStates: useAgentAttention.getState().displayStates,
		agentActivity: useStore.getState().agentActivity,
	};
}

async function run(report: (phase: string, facts?: object) => void) {
	const home = await homeDir();
	check(
		home.includes("/dure-work-view-ended.") && home.endsWith("/home"),
		"Work view QA escaped its disposable HOME",
	);
	await waitFor("The store did not hydrate", () => useStore.persist.hasHydrated());
	await waitFor("The workspace did not mount", () =>
		Boolean(getDockview(useStore.getState().activeSpaceId)),
	);
	useWindowSidebarStore.setState({ open: true });
	useWindowSidebarStore.getState().setTab("work");
	report("ready");

	for (const scene of SCENES) {
		seed(scene, home);
		await durableAppStorage.flush();
		const seeded = () => {
			const state = useStore.getState();
			const states = useAgentAttention.getState().displayStates;
			return (
				state.agents.length === scene.agents.length &&
				scene.agents.every((entry) => states[entry.id] === expectedState(entry))
			);
		};
		await settle(`The ${scene.name} scene did not settle`, seeded);
		for (const theme of THEMES) {
			useStore.getState().setUiPrefs({ theme });
			await durableAppStorage.flush();
			await settle(
				`The ${theme} theme did not hold`,
				() =>
					seeded() &&
					document.documentElement.classList.contains("dark") ===
						(theme === "dark"),
			);
			const phase = `${scene.name}-${theme}`;
			report(phase, facts());
			await waitForFile(
				`${home}/captured-${phase}`,
				`The ${phase} capture was not acknowledged`,
			);
		}
	}
	report("done");
}

/** The client writes a marker once it has captured the window. */
async function waitForFile(path: string, message: string, timeoutMs = 180_000) {
	const deadline = performance.now() + timeoutMs;
	for (;;) {
		try {
			await readFile(path);
			return;
		} catch {
			check(performance.now() < deadline, message);
			await new Promise((done) => setTimeout(done, 100));
		}
	}
}

export async function runWorkViewEndedProbe() {
	const proof = new URLSearchParams(location.search).get("qaWorkViewEnded");
	if (!import.meta.env.DEV || !proof) return;
	const report = (phase: string, facts: object = {}) =>
		qaLog(`work-view-ended-${phase}`, { proof, ...facts });
	try {
		report("started");
		await run(report);
	} catch (error) {
		report("failed", {
			error: error instanceof Error ? error.message : String(error),
			facts: facts(),
		});
	}
}
