import { describe, expect, it } from "vitest";
import { renderHomeScreen, type CensusModel } from "./censusView";
import { homeRows, needsYou, recentlyFinished } from "./homeProjection";
import { t } from "./i18n";
import type { HubProbeSession } from "./ipc";

const now = 1_700_000_000_000;

/** A row the computer names an Agent for, managed by `manager` when given. */
function session(
	id: string,
	displayState: string,
	manager?: string,
	patch: Partial<HubProbeSession> = {},
): HubProbeSession {
	return {
		session_id: `session-${id}`,
		session_name: `Agent ${id}`,
		workspace_id: "qa",
		session_class: "managed",
		lifecycle: "ready",
		provider_id: "claude",
		runner_principal: "qa",
		runner_instance: "i",
		channel_epoch: "e",
		host_instance_id: "h",
		terminal_epoch: `epoch-${id}`,
		capabilities: [],
		ready: true,
		box_id: "this-laptop",
		box_label: "QA Mac",
		conversation: true,
		...patch,
		presentation: {
			displayState: displayState as never,
			activityAt: now - 60_000,
			projectName: "Dure",
			kind: "agent",
			provider: "claude",
			agentId: `agent-${id}`,
			...(manager ? { managerAgentId: `agent-${manager}` } : {}),
			...patch.presentation,
		},
	};
}

function model(sessions: HubProbeSession[]): CensusModel {
	return {
		census: [],
		hubs: [{ hubId: "qa-hub", hubLabel: "QA Mac", reachable: true, sessions }],
		layout: {
			desktop_order: ["Work"],
			placements: Object.fromEntries(
				sessions.map((row, order) => [row.session_id, { desktop: "Work", project: "Dure", order }]),
			),
		},
		failures: [],
		busy: false,
		emptyMessage: "",
	};
}

const rowsOf = (sessions: HubProbeSession[]) => homeRows(model(sessions)).rows;
const agentOf = (sessions: HubProbeSession[], id: string) =>
	rowsOf(sessions).find((view) => view.row.sessionId === `session-${id}`)?.agent;

/** coordinator › lead › worker › helper, plus a second lead with nothing below. */
const team = (): HubProbeSession[] => [
	session("coordinator", "waiting"),
	session("lead", "working", "coordinator"),
	session("worker", "working", "lead"),
	session("helper", "blocked", "worker"),
	session("reviewer", "input", "coordinator"),
];

describe("home relations", () => {
	it("gives a nested agent its path at any depth and a manager its subtree", () => {
		const sessions = team();
		expect(agentOf(sessions, "helper")?.path).toEqual(["Agent coordinator", "Agent lead", "Agent worker"]);
		expect(agentOf(sessions, "coordinator")?.path).toBeUndefined();
		// Everything below, a person needed for two, the two working ones not
		// counted again among them.
		expect(agentOf(sessions, "coordinator")?.managed).toEqual({ count: 4, needsPerson: 2, working: 2 });
		expect(agentOf(sessions, "worker")?.managed).toEqual({ count: 1, needsPerson: 1, working: 0 });
		expect(agentOf(sessions, "reviewer")?.managed).toBeUndefined();
	});

	it("puts the path on the Needs you card, whatever order the waits came in", () => {
		const cards = needsYou(rowsOf(team()));
		expect(cards.map((card) => [card.view.row.title, card.view.agent?.path])).toEqual([
			["Agent helper", ["Agent coordinator", "Agent lead", "Agent worker"]],
			["Agent reviewer", ["Agent coordinator"]],
		]);
	});

	it("counts a cycle once and lists each of its agents", () => {
		const sessions = [
			session("a", "working", "b"),
			session("b", "blocked", "a"),
			session("c", "working", "b"),
		];
		const rows = rowsOf(sessions);
		expect(rows).toHaveLength(3);
		// Broken where the listing starts it: "a" is the root.
		expect(agentOf(sessions, "a")?.path).toBeUndefined();
		expect(agentOf(sessions, "b")?.path).toEqual(["Agent a"]);
		expect(agentOf(sessions, "c")?.path).toEqual(["Agent a", "Agent b"]);
		expect(agentOf(sessions, "a")?.managed).toEqual({ count: 2, needsPerson: 1, working: 1 });
	});

	it("lists an agent whose manager this phone has no row for, or that an older computer did not name, at the top", () => {
		const sessions = [
			session("orphan", "blocked", "elsewhere"),
			session("older", "input", undefined, { presentation: { agentId: undefined } }),
			session("shell", "working", undefined, { presentation: { agentId: undefined, kind: "term" } }),
		];
		for (const id of ["orphan", "older", "shell"]) {
			expect(agentOf(sessions, id)?.path).toBeUndefined();
			expect(agentOf(sessions, id)?.managed).toBeUndefined();
		}
		expect(needsYou(rowsOf(sessions)).map((card) => card.view.row.title)).toEqual([
			"Agent older",
			"Agent orphan",
		]);
	});

	it("keeps an agent a person is needed for out of Has a result", () => {
		const exited = session("crashed", "waiting", undefined, {
			failure: { code: "provider_exited", terminal_epoch: "epoch-crashed", occurred_unix_ms: String(now) },
		});
		const rows = rowsOf([exited, session("done", "waiting")]);
		expect(recentlyFinished(rows, now).map((card) => card.view.row.title)).toEqual(["Agent done"]);
		expect(needsYou(rows).map((card) => card.status)).toEqual(["unexpected_exit"]);
	});

	it("draws the path over the card and the list row, and what a manager manages under them", () => {
		document.body.replaceChildren(
			renderHomeScreen(model(team()), {
				open: () => {},
				selectDesktop: () => {},
				pair: () => {},
				settings: () => {},
				refresh: () => {},
				hold: () => {},
			}),
		);
		const helper = document.querySelector('[data-needs-you="session-helper"]')!;
		expect(helper.querySelector(".home-card__path")?.textContent).toBe(
			"Agent coordinator › Agent lead › Agent worker",
		);
		expect(helper.querySelector(".home-card__managed")).toBeNull();

		const row = (id: string) => document.querySelector(`[data-session-id="session-${id}"]`)!;
		expect(row("coordinator").querySelector(".session-row__path")).toBeNull();
		expect(row("coordinator").querySelector(".session-row__managed")?.textContent).toBe(
			[
				t("home.row.manages", { n: 4 }),
				t("home.row.managedNeedYou", { n: 2 }),
				t("home.row.managedWorking", { n: 2 }),
			].join(" · "),
		);
		expect(row("worker").querySelector(".session-row__path")?.textContent).toBe(
			"Agent coordinator › Agent lead",
		);
		expect(row("worker").querySelector(".session-row__managed")?.textContent).toBe(
			[t("home.row.manages", { n: 1 }), t("home.row.managedNeedYou", { n: 1 })].join(" · "),
		);
	});
});
