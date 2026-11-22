import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	ConversationCursor,
	ConversationTranscriptAnswer,
	HubProbe,
	HubProbeSession,
} from "./ipc";

const native = vi.hoisted(() => ({
	hubList: vi.fn(),
	hubLayouts: vi.fn(),
	listServers: vi.fn(),
	takeSessionCensus: vi.fn(),
	hubOpen: vi.fn(),
	hubConversationTranscript: vi.fn(),
	attachHubSession: vi.fn(),
}));
vi.mock("./ipc", () => ({ ipc: native }));

import { startApp } from "./app";
import { renderHomeScreen, type CensusModel } from "./censusView";
import { answerLine, createFinalResponseReader } from "./finalResponses";
import {
	type FinishedCard,
	homeRows,
	RECENTLY_FINISHED_LIMIT,
	RECENTLY_FINISHED_WINDOW_MS,
	recentlyFinished,
} from "./homeProjection";
import { t } from "./i18n";

const now = 1_700_000_000_000;

function session(
	id: string,
	displayState: string,
	patch: Partial<HubProbeSession> = {},
): HubProbeSession {
	return {
		session_id: id,
		session_name: `Agent ${id}`,
		workspace_id: "qa",
		session_class: "managed",
		lifecycle: "ready",
		provider_id: "codex",
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
			provider: "codex",
			...patch.presentation,
		},
	};
}

function model(sessions: HubProbeSession[], reachable = true): CensusModel {
	return {
		census: [],
		hubs: [{ hubId: "qa-hub", hubLabel: "QA Mac", reachable, sessions }],
		layout: {
			desktop_order: ["Work", "Personal"],
			placements: Object.fromEntries(
				sessions.map((row, order) => [
					row.session_id,
					{ desktop: order % 2 ? "Personal" : "Work", project: "Dure", order },
				]),
			),
		},
		failures: [],
		busy: false,
		emptyMessage: "",
	};
}

const finishedOf = (sessions: HubProbeSession[], reachable = true) =>
	recentlyFinished(homeRows(model(sessions, reachable)).rows, now);
const ids = (cards: readonly FinishedCard[]) => cards.map((card) => card.view.row.sessionId);

const cursor = (turns: number): ConversationCursor => ({
	terminal_epoch: "epoch",
	conversation_id: "conversation",
	turn_completed_count: turns,
	turn_open: false,
	runtime_revision: turns,
});
const transcript = (finalResponse: string | null, turns = 1): ConversationTranscriptAnswer => ({
	outcome: "transcript",
	entries: [],
	final_response: finalResponse,
	history_complete: false,
	cursor: cursor(turns),
});
const unchanged: ConversationTranscriptAnswer = {
	outcome: "unchanged",
	entries: [],
	history_complete: false,
};

describe("recentlyFinished", () => {
	it("lists idle agents across Spaces, newest first, up to the limit", () => {
		const cards = finishedOf([
			session("oldest", "waiting", { presentation: { activityAt: now - 50_000_000 } }),
			session("working", "working"),
			session("asks", "input"),
			session("blocked", "blocked"),
			session("newest", "waiting", { presentation: { activityAt: now - 1_000 } }),
			session("middle", "waiting", { presentation: { activityAt: now - 30_000 } }),
			session("older", "waiting", { presentation: { activityAt: now - 40_000 } }),
		]);
		expect(RECENTLY_FINISHED_LIMIT).toBe(3);
		expect(ids(cards)).toEqual(["newest", "middle", "older"]);
		expect(cards[0].source).toMatchObject({ kind: "hub", hubId: "qa-hub" });
		expect(cards[0].key).toBe(JSON.stringify(["qa-hub", "this-laptop", "qa", "newest"]));
	});

	it("leaves out agents whose answer this phone cannot read, or that finished long ago", () => {
		expect(
			finishedOf([
				session("no-chat", "waiting", { conversation: false }),
				session("older-computer", "waiting", { conversation: undefined }),
				session("gone", "waiting", { ready: false }),
				session("stale", "waiting", {
					presentation: { activityAt: now - RECENTLY_FINISHED_WINDOW_MS - 1 },
				}),
				session("never", "waiting", { presentation: { activityAt: undefined } }),
				session("exited", "exited"),
			]),
		).toEqual([]);
		expect(finishedOf([session("offline", "waiting")], false)).toEqual([]);
	});
});

describe("answerLine", () => {
	it("is the answer's first line as plain text", () => {
		expect(answerLine("Done. All 12 tests pass.\nSecond line.")).toBe("Done. All 12 tests pass.");
		expect(answerLine("\n\n## Summary\n\nFixed it.")).toBe("Summary");
		expect(answerLine("**Merged** PR `#42`.")).toBe("Merged PR #42.");
		expect(answerLine("- first item\n- second")).toBe("first item");
		expect(answerLine("```\n\n```\n\n```sh\npnpm test\n```")).toBe("pnpm test");
		expect(answerLine("   spaced    out   ")).toBe("spaced out");
		expect(answerLine("  \n ")).toBeUndefined();
		expect([...(answerLine("가".repeat(400)) ?? "")]).toHaveLength(280);
	});
});

describe("the final response reader", () => {
	const card = (id: string, activityAt = now - 60_000, epoch = `epoch-${id}`) =>
		finishedOf([
			session(id, "waiting", { terminal_epoch: epoch, presentation: { activityAt } }),
		])[0];
	async function settle(): Promise<void> {
		for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
	}

	it("reads once per finished turn, with the last cursor, and says when a line changes", async () => {
		const read = vi.fn().mockResolvedValue(transcript("All green.\nDetails…"));
		const changed = vi.fn();
		const reader = createFinalResponseReader({ read, changed });
		const first = card("a");

		reader.observe([first]);
		expect(read).toHaveBeenCalledWith(first, undefined);
		await settle();
		expect(reader.lines()).toEqual({ [first.key]: "All green." });
		expect(changed).toHaveBeenCalledTimes(1);

		// The same row again: nothing moved, nothing is asked.
		reader.observe([card("a")]);
		await settle();
		expect(read).toHaveBeenCalledTimes(1);

		// It moved: asked with the cursor, and an unchanged turn keeps its line.
		read.mockResolvedValueOnce(unchanged);
		reader.observe([card("a", now - 1_000)]);
		await settle();
		expect(read).toHaveBeenLastCalledWith(expect.objectContaining({ key: first.key }), cursor(1));
		expect(reader.lines()).toEqual({ [first.key]: "All green." });
		expect(changed).toHaveBeenCalledTimes(1);

		// A replaced process is asked again too, and a new answer replaces the line.
		read.mockResolvedValueOnce(transcript("Second turn done.", 2));
		reader.observe([card("a", now - 1_000, "epoch-new")]);
		await settle();
		expect(reader.lines()).toEqual({ [first.key]: "Second turn done." });
		expect(changed).toHaveBeenCalledTimes(2);
	});

	it("shows nothing for a turn without an answer or a refused read", async () => {
		const read = vi.fn().mockResolvedValueOnce(transcript("Done."));
		const reader = createFinalResponseReader({ read, changed: () => {} });
		reader.observe([card("a")]);
		await settle();
		expect(Object.keys(reader.lines())).toHaveLength(1);

		read.mockResolvedValueOnce(transcript(null, 2));
		reader.observe([card("a", now - 2_000)]);
		await settle();
		expect(reader.lines()).toEqual({});

		read.mockResolvedValueOnce({ outcome: "refused", entries: [], history_complete: false, code: "transcript_unavailable" });
		reader.observe([card("a", now - 1_000)]);
		await settle();
		expect(reader.lines()).toEqual({});
		// A refusal drops the cursor: the next read asks from the start.
		read.mockResolvedValueOnce(transcript("Back."));
		reader.observe([card("a", now - 500)]);
		await settle();
		expect(read).toHaveBeenLastCalledWith(expect.anything(), undefined);
	});

	it("forgets an agent home stops listing, so its next turn never shows the old answer", async () => {
		const read = vi.fn().mockResolvedValue(transcript("Old answer."));
		const reader = createFinalResponseReader({ read, changed: () => {} });
		const listed = card("a");
		reader.observe([listed]);
		await settle();

		// Working again: no longer listed.
		reader.observe([]);
		expect(reader.lines()).toEqual({});
		// Finished again with the same activity time: read afresh, shown only once it lands.
		let land: (answer: ConversationTranscriptAnswer) => void = () => {};
		read.mockReturnValueOnce(new Promise((resolve) => { land = resolve; }));
		reader.observe([card("a")]);
		expect(read).toHaveBeenLastCalledWith(expect.anything(), undefined);
		expect(reader.lines()).toEqual({});
		land(transcript("New answer.", 2));
		await settle();
		expect(reader.lines()).toEqual({ [listed.key]: "New answer." });
	});

	it("asks once more after a read the row moved under, and again after a lost one", async () => {
		let land: (answer: ConversationTranscriptAnswer) => void = () => {};
		const read = vi.fn().mockReturnValueOnce(new Promise((resolve) => { land = resolve; }));
		const reader = createFinalResponseReader({ read, changed: () => {} });
		reader.observe([card("a")]);
		reader.observe([card("a", now - 1_000)]);
		reader.observe([card("a", now - 500)]);
		expect(read).toHaveBeenCalledTimes(1);
		read.mockResolvedValueOnce(transcript("Latest.", 2));
		land(transcript("Earlier.", 1));
		await settle();
		expect(read).toHaveBeenCalledTimes(2);
		expect(read).toHaveBeenLastCalledWith(
			expect.objectContaining({ view: expect.objectContaining({ activityAt: now - 500 }) }),
			cursor(1),
		);
		expect(Object.values(reader.lines())).toEqual(["Latest."]);

		read.mockRejectedValueOnce(new Error("conversation_no_answer"));
		reader.observe([card("a", now - 100)]);
		await settle();
		expect(Object.values(reader.lines())).toEqual(["Latest."]);
		read.mockResolvedValueOnce(transcript("Retried.", 3));
		reader.observe([card("a", now - 100)]);
		await settle();
		expect(read).toHaveBeenCalledTimes(4);
		expect(Object.values(reader.lines())).toEqual(["Retried."]);
	});
});

describe("the Recently finished section on home", () => {
	// Home draws against the clock; the fixtures finished a minute before `now`.
	beforeEach(() => vi.useFakeTimers({ now }));
	afterEach(() => vi.useRealTimers());
	function draw(sessions: HubProbeSession[], answers: Record<string, string>) {
		const open = vi.fn();
		const readFinished = vi.fn();
		document.body.replaceChildren(
			renderHomeScreen(
				{ ...model(sessions), finishedAnswers: answers },
				{
					open,
					readFinished,
					selectDesktop: () => {},
					pair: () => {},
					settings: () => {},
					refresh: () => {},
					hold: () => {},
				},
			),
		);
		return { open, readFinished };
	}
	const keyOf = (id: string) => JSON.stringify(["qa-hub", "this-laptop", "qa", id]);
	const section = () => document.querySelector(".finished");

	it("asks for the listed agents' answers and shows only the ones that have one", () => {
		const { readFinished } = draw(
			[session("done", "waiting"), session("quiet", "waiting"), session("working", "working")],
			{ [keyOf("done")]: "Shipped the fix." },
		);
		expect(readFinished).toHaveBeenCalledTimes(1);
		expect(ids(readFinished.mock.calls[0][0])).toEqual(["done", "quiet"]);
		expect(section()?.querySelector(".group-heading")?.textContent).toBe(
			`${t("home.finished.title")}1`,
		);
		const cards = document.querySelectorAll(".finished__card");
		expect(cards).toHaveLength(1);
		expect(cards[0].querySelector(".home-card__agent")?.textContent).toBe("Agent done");
		expect(cards[0].querySelector(".home-card__project")?.textContent).toBe("Dure");
		expect(cards[0].querySelector(".finished__answer")?.textContent).toBe("Shipped the fix.");
		expect(cards[0].querySelector(".finished__when")?.textContent).not.toBe("");
	});

	it("is absent without an answer, and the list below keeps every row", () => {
		draw([session("done", "waiting"), session("working", "working")], {});
		expect(section()).toBeNull();
		expect(document.querySelectorAll(".session-row")).toHaveLength(1);
	});

	it("sits under Needs you and above the list, and opens the agent", () => {
		const { open } = draw(
			[session("done", "waiting"), session("ask", "input")],
			{ [keyOf("done")]: "Shipped." },
		);
		const body = document.querySelector(".home__body")!;
		const order = [...body.children].map((child) => child.className.split(" ").pop());
		expect(order.indexOf("needs-you")).toBeLessThan(order.indexOf("finished"));
		expect(order.indexOf("finished")).toBeLessThan(order.indexOf("home__list"));
		document.querySelector<HTMLButtonElement>(".finished__open")!.click();
		expect(open).toHaveBeenCalledWith(expect.objectContaining({ kind: "hub", hubId: "qa-hub" }));
		expect(open.mock.calls[0][0].session.session_id).toBe("done");
	});
});

describe("Recently finished in the app", () => {
	const hub = { id: "qa-hub", box_label: "QA computer", endpoint: "qa", relay_offered: true };
	function probe(sessions: HubProbeSession[]): HubProbe {
		return {
			...hub,
			device_label: "QA phone",
			sessions,
			layout_note: null,
			direct_pairing: null,
			direct_pairing_error: null,
			unreachable: [],
			layout: {
				desktop_order: ["QA"],
				placements: Object.fromEntries(
					sessions.map((row, order) => [row.session_id, { desktop: "QA", project: "Dure", order }]),
				),
			},
		};
	}
	async function settle(): Promise<void> {
		for (let i = 0; i < 5; i += 1) {
			await vi.dynamicImportSettled();
			for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
		}
	}
	let root: HTMLElement;
	let dispose: (() => void) | undefined;
	const finishedAt = Date.now() - 60_000;
	const done = () => session("done", "waiting", { presentation: { activityAt: finishedAt } });
	const card = () => root.querySelector('[data-finished="done"]');

	beforeEach(() => {
		vi.useFakeTimers({ now: Date.now() });
		vi.clearAllMocks();
		localStorage.clear();
		Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
		native.hubList.mockResolvedValue([hub]);
		native.hubLayouts.mockResolvedValue({});
		native.listServers.mockResolvedValue({ version: 3, servers: [] });
		native.takeSessionCensus.mockResolvedValue([]);
		native.hubOpen.mockResolvedValue(probe([done()]));
		native.hubConversationTranscript.mockResolvedValue(
			transcript("## Result\n\nAll 48 checks passed."),
		);
		root = document.createElement("div");
		document.body.replaceChildren(root);
	});
	afterEach(() => {
		dispose?.();
		dispose = undefined;
		root.remove();
		vi.useRealTimers();
	});

	it("reads the answer only, shows its first line, and asks again only when the agent moves", async () => {
		dispose = startApp(root);
		await settle();
		expect(native.hubConversationTranscript).toHaveBeenCalledWith(
			"qa-hub",
			{ boxId: "this-laptop", workspaceId: "qa", sessionId: "done" },
			undefined,
			0,
		);
		expect(card()?.querySelector(".finished__answer")?.textContent).toBe("Result");

		// The 2 s catalog reads that find it unmoved ask nothing more.
		await vi.advanceTimersByTimeAsync(4_100);
		expect(native.hubOpen.mock.calls.length).toBeGreaterThan(1);
		expect(native.hubConversationTranscript).toHaveBeenCalledTimes(1);

		// Working on a new prompt: the card leaves at once.
		native.hubOpen.mockResolvedValue(probe([session("done", "working")]));
		await vi.advanceTimersByTimeAsync(2_100);
		expect(card()).toBeNull();
		expect(root.querySelector('[data-session-id="done"]')).not.toBeNull();
	});
});
