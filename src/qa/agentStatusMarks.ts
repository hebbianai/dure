import type { AgentDisplayState } from "@/lib/agents/agentStateModel";
import { t } from "@/lib/i18n";
import { homeDir } from "@/lib/ipc";
import { readFile } from "@/lib/ipc/files";
import type { HmuxAgentRuntimeState } from "@/lib/ipc/hmuxContracts";
import { qaLog } from "@/lib/qa/qaLog";
import { useWindowSidebarStore } from "@/lib/sidebar/windowSidebarStore";
import { useWorkViewStore } from "@/lib/work/workViewStore";
import { useStore } from "@/store";
import type { Agent } from "@/types";

/** A lead and the agents it manages, one per display state the status mark
 * draws, the working ones several so a Space reads like a busy one. */
const LEAD = "qa-status-lead";
const AGENTS: [id: string, title: string, state: AgentDisplayState][] = [
	[LEAD, "Lead: release 0.3 checks", "working"],
	["qa-status-auth", "Fix the auth token refresh", "working"],
	["qa-status-index", "Search index rebuild", "working"],
	["qa-status-queue", "Migrate orders to the new queue", "working"],
	["qa-status-approval", "Payments webhook retries", "blocked"],
	["qa-status-input", "Docs for the CLI", "input"],
	["qa-status-error", "Inventory sync", "error"],
	["qa-status-done", "Update the changelog", "waiting"],
	["qa-status-idle", "Analytics events", "waiting"],
	["qa-status-starting", "Mobile push registration", "connecting"],
	["qa-status-exited", "Rate limiter", "exited"],
];

/** The Host triple each state resolves from (resolveAgentState). */
const HOST: Record<
	Exclude<AgentDisplayState, "unknown">,
	Pick<HmuxAgentRuntimeState, "lifecycle" | "activity" | "attention">
> = {
	working: { lifecycle: "running", activity: "working", attention: "none" },
	waiting: { lifecycle: "running", activity: "waiting", attention: "none" },
	input: { lifecycle: "running", activity: "waiting", attention: "input_required" },
	blocked: {
		lifecycle: "running",
		activity: "waiting",
		attention: "approval_required",
	},
	error: { lifecycle: "running", activity: "waiting", attention: "error" },
	connecting: { lifecycle: "starting", activity: "waiting", attention: "none" },
	exited: { lifecycle: "exited", activity: "waiting", attention: "none" },
};

function check(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

async function waitFor(message: string, ready: () => boolean, timeoutMs = 30_000) {
	const deadline = performance.now() + timeoutMs;
	while (!ready()) {
		check(performance.now() < deadline, message);
		await new Promise((done) => setTimeout(done, 50));
	}
}

function agent(id: string, title: string, index: number): Agent {
	return {
		id,
		name: id,
		displayName: title,
		provider: index % 2 ? "claude" : "codex",
		projectId: "qa-project",
		worktreePath: `/qa/work/${id}`,
		branch: id,
		sessionId: `qa-session-${id}`,
		sessionKind: "pty",
		...(id === LEAD ? {} : { runParent: { agentId: LEAD } }),
	} as Agent;
}

/** Writes each agent's Host state and reports whether all of them read as
 * the state they stand for. */
function seedStates(): boolean {
	const store = useStore.getState();
	const shown = store.agents;
	for (const [id, , state] of AGENTS) {
		const sessionId = `qa-session-${id}`;
		const host = HOST[state as keyof typeof HOST];
		const current = store.sessionAgentRuntimeState[sessionId];
		if (
			current?.lifecycle === host.lifecycle &&
			current.activity === host.activity &&
			current.attention === host.attention
		)
			continue;
		store.setSessionAgentRuntimeState(sessionId, {
			terminalEpoch: `qa-terminal-${id}`,
			revision: "1",
			observedThroughOutputSeq: "0",
			source: "provider_event",
			...host,
		});
	}
	return AGENTS.every(([id]) => shown.some((entry) => entry.id === id));
}

/** Every mark on screen: its row, the state it stands for, and how it is
 * drawn — the colour, and whether its ring breathes. */
function marks() {
	return Array.from(
		document.querySelectorAll<HTMLElement>(".agent-status-dot[data-agent-tone]"),
		(dot) => {
			const style = getComputedStyle(dot);
			const ring = getComputedStyle(dot, "::after");
			return {
				label: dot.getAttribute("aria-label"),
				row:
					dot.closest("[data-agent-row-key]")?.getAttribute("data-agent-row-key") ??
					null,
				tone: dot.dataset.agentTone,
				fill: dot.dataset.agentFill,
				motion: dot.dataset.agentMotion,
				background: style.backgroundColor,
				border: style.borderTopColor,
				ring: ring.animationName,
				ringState: ring.animationPlayState,
				pulse: style.animationName,
			};
		},
	);
}

function tokens() {
	const style = getComputedStyle(document.documentElement);
	return Object.fromEntries(
		["--status-run", "--status-blocked", "--status-error", "--muted-foreground"].map(
			(name) => [name, style.getPropertyValue(name).trim()],
		),
	);
}

/** A fresh home raises the first-run tooling notice a minute in; the probe
 * closes it the way a person would, so it covers no capture. */
function dismissNotices() {
	const close = JSON.stringify(t("common.close"));
	for (const button of document.querySelectorAll<HTMLButtonElement>(
		`section > div > button[aria-label=${close}]`,
	)) {
		button.click();
	}
}

async function captured(home: string, phase: string) {
	const deadline = performance.now() + 180_000;
	for (;;) {
		dismissNotices();
		try {
			await readFile(`${home}/agent-status-captured-${phase}`);
			return;
		} catch {
			check(performance.now() < deadline, `The client did not capture ${phase}`);
			await new Promise((done) => setTimeout(done, 100));
		}
	}
}

/** Inside the real App in WKWebView: agents in every display state, in the
 * Work view and the Spaces sidebar, light and dark. */
async function run(report: (phase: string, facts?: object) => void) {
	const home = await homeDir();
	check(
		home.includes("/dure-agent-status-marks.") && home.endsWith("/home"),
		"Agent status QA escaped its disposable HOME",
	);
	await waitFor("The agent registry did not hydrate", () =>
		useStore.persist.hasHydrated(),
	);
	// The seeded attention is the probe's, not the person's: no desktop
	// notification or Dock badge leaves the disposable app.
	useStore.setState((state) => ({
		notifyPrefs: { ...state.notifyPrefs, enabled: false, appIconBadge: false },
		agents: [
			...state.agents.filter((entry) => !AGENTS.some(([id]) => id === entry.id)),
			...AGENTS.map(([id, title], index) => agent(id, title, index)),
		],
	}));
	useWorkViewStore.getState().setManagedOpen(true);
	useWorkViewStore.getState().select(LEAD);

	const phases: [string, "work" | "spaces", "light" | "dark"][] = [
		["work-light", "work", "light"],
		["work-dark", "work", "dark"],
		["spaces-light", "spaces", "light"],
		["spaces-dark", "spaces", "dark"],
		["motion-dark", "work", "dark"],
		["motion-light", "work", "light"],
	];
	for (const [phase, tab, theme] of phases) {
		useWindowSidebarStore.getState().setTab(tab);
		// The states and the theme hold for half a second: the app may still
		// apply its saved appearance, or a projection may write over a seed.
		let steady = 0;
		await waitFor(
			`The ${phase} states did not hold`,
			() => {
				if (useStore.getState().uiPrefs?.theme !== theme)
					useStore.getState().setUiPrefs({ theme });
				const seeded = seedStates();
				const shown =
					document.documentElement.classList.contains("dark") === (theme === "dark");
				const working = document.querySelectorAll(
					'.agent-status-dot[data-agent-motion="breathe"]',
				).length;
				steady = seeded && shown && working > 0 ? steady + 1 : 0;
				return steady >= 10;
			},
			60_000,
		);
		dismissNotices();
		await new Promise((done) =>
			requestAnimationFrame(() => requestAnimationFrame(done)),
		);
		report(phase, {
			dark: document.documentElement.classList.contains("dark"),
			reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
			tokens: tokens(),
			marks: marks(),
		});
		await captured(home, phase);
	}
	report("done");
}

export async function runAgentStatusMarksProbe() {
	const proof = new URLSearchParams(location.search).get("qaAgentStatusMarks");
	if (!import.meta.env.DEV || !proof) return;
	const report = (phase: string, facts: object = {}) =>
		qaLog(`agent-status-marks-${phase}`, { proof, ...facts });
	try {
		report("started");
		await run(report);
	} catch (error) {
		report("failed", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}
