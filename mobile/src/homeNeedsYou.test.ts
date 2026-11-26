import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentApprovalChoice, PendingApproval } from "@/lib/agents/approvalRequest";
import type { HubProbe, HubProbeSession } from "./ipc";

const native = vi.hoisted(() => ({
	hubList: vi.fn(),
	hubLayouts: vi.fn(),
	listServers: vi.fn(),
	takeSessionCensus: vi.fn(),
	hubOpen: vi.fn(),
	hubAgentApprovalAnswer: vi.fn(),
	attachHubSession: vi.fn(),
	pushActivations: vi.fn(),
	pushAlertActions: vi.fn(),
}));
const biometric = vi.hoisted(() => ({ authenticate: vi.fn() }));
vi.mock("./ipc", () => ({ ipc: native }));
vi.mock("@tauri-apps/plugin-biometric", () => ({
	checkStatus: () => Promise.resolve({ isAvailable: true }),
	authenticate: biometric.authenticate,
}));

import { startApp } from "./app";
import { renderHomeScreen, type CensusModel } from "./censusView";
import { continuesText } from "./agentRowText";
import { homeRows, needsYou, type NeedsYouCard } from "./homeProjection";
import { t } from "./i18n";
import type { PushActivation } from "./pushActivation";
import {
	DEFAULT_SETTINGS_PREFERENCES,
	saveSettingsPreferences,
} from "./settingsPreferences";

const now = 1_700_000_000_000;
const approval: PendingApproval = {
	attentionId: "attention-7",
	request: {
		toolName: "Bash",
		summary: "cargo test -p dure",
		choices: ["approve", "approve_always", "deny"],
	},
};

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
		approval_answer: true,
		...patch,
		presentation: {
			displayState: displayState as never,
			activityAt: now,
			projectName: "Dure",
			kind: "agent",
			provider: "claude",
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

const cardsOf = (sessions: HubProbeSession[], reachable = true) =>
	needsYou(homeRows(model(sessions, reachable)).rows);

describe("needsYou", () => {
	it("lists every agent only a person can move forward, across Spaces, newest wait first, and nothing else", () => {
		const cards = cardsOf([
			session("older-approval", "blocked", { presentation: { activityAt: now - 60_000 } }),
			session("working", "working"),
			session("idle", "waiting"),
			session("question", "input", { presentation: { activityAt: now - 1_000 } }),
			session("errored", "error"),
		]);
		expect(cards.map((card) => [card.view.row.sessionId, card.status])).toEqual([
			["errored", "error"],
			["question", "input"],
			["older-approval", "approval"],
		]);
	});

	/** #726: the computer's backend continues a limited agent by itself
	 * after the reset, so its error waits for no one on the phone either. A
	 * question or an approval still does. */
	it("leaves out an error the computer continues after its limit resets", () => {
		const waiting = { presentation: { continuesAtMs: now + 600_000 } };
		const sessions = [
			session("limited", "error", waiting),
			session("question", "input", waiting),
			session("approval", "blocked", waiting),
			session("errored", "error"),
		];
		expect(cardsOf(sessions).map((card) => [card.view.row.sessionId, card.status])).toEqual([
			["approval", "approval"],
			["errored", "error"],
			["question", "input"],
		]);
		const rows = homeRows(model(sessions)).rows;
		const row = (id: string) => rows.find((view) => view.row.sessionId === id);
		expect(row("limited")?.need).toBeUndefined();
		// The row says when it continues; a row listed for a person says why.
		expect(row("limited")?.agent?.continuesAtMs).toBe(now + 600_000);
		expect(row("question")?.agent?.continuesAtMs).toBeUndefined();
	});

	/** The Host's exit record, as the computer copies it to the catalog. */
	const exitOf = (id: string, code = "provider_exited", epoch = `epoch-${id}`) => ({
		code,
		terminal_epoch: epoch,
		occurred_unix_ms: String(now - 5_000),
	});

	it("lists an agent that exited on its own even though its session cannot be opened", () => {
		const cards = cardsOf([
			session("crashed", "exited", { ready: false, lifecycle: "exited", failure: exitOf("crashed") }),
			session("signed-out", "exited", {
				ready: false,
				lifecycle: "exited",
				failure: exitOf("signed-out", "provider_exited_at_sign_in"),
			}),
			// The record wins over what the screen last showed: that process is gone.
			session("was-asking", "blocked", { ready: false, failure: exitOf("was-asking") }),
			session("asking", "input"),
		]);
		expect(cards.map((card) => [card.view.row.sessionId, card.status])).toEqual([
			["asking", "input"],
			["crashed", "unexpected_exit"],
			["signed-out", "sign_in_exit"],
			["was-asking", "unexpected_exit"],
		]);
	});

	it("leaves out a stop someone asked for, an exit from an earlier process, and an offline computer", () => {
		expect(cardsOf([session("stopped", "exited", { ready: false, lifecycle: "exited" })])).toEqual([]);
		expect(
			cardsOf([
				session("restarted", "working", { failure: exitOf("restarted", "provider_exited", "epoch-old") }),
			]),
		).toEqual([]);
		expect(cardsOf([session("crashed", "exited", { ready: false, failure: exitOf("crashed") })], false)).toEqual([]);
	});

	it("leaves out agents that cannot be opened now", () => {
		expect(cardsOf([session("gone", "blocked", { ready: false })])).toEqual([]);
		expect(cardsOf([session("offline", "blocked")], false)).toEqual([]);
	});

	it("answers in place only an approval the computer carried and answers from here", () => {
		const [answerable] = cardsOf([
			session("a", "blocked", { presentation: { approval } }),
		]);
		expect(answerable.approval).toEqual(approval);

		// The same validator as the Host's own record: a malformed request, or
		// a computer that does not answer approvals, leaves the card to open the agent.
		for (const patch of [
			{ approval_answer: false, presentation: { approval } },
			{ presentation: { approval: { attentionId: "", request: approval.request } } },
			{ presentation: { approval: { ...approval, request: { toolName: "Bash", choices: ["approve"] } } } },
			{},
		] as Partial<HubProbeSession>[]) {
			const [card] = cardsOf([session("b", "blocked", patch)]);
			expect(card.status).toBe("approval");
			expect(card.approval).toBeUndefined();
		}
		// An approval rides only on the wait it names.
		const [question] = cardsOf([session("c", "input", { presentation: { approval } })]);
		expect(question.approval).toBeUndefined();
	});
});

describe("the Needs you section on home", () => {
	function draw(
		sessions: HubProbeSession[],
		approvalAnswers: CensusModel["approvalAnswers"] = {},
	) {
		const open = vi.fn();
		const info = vi.fn();
		const answerApproval = vi.fn<(card: NeedsYouCard, choice: AgentApprovalChoice) => void>();
		document.body.replaceChildren(
			renderHomeScreen(
				{ ...model(sessions), approvalAnswers },
				{
					open,
					info,
					answerApproval,
					selectDesktop: () => {},
					pair: () => {},
					settings: () => {},
					refresh: () => {},
					hold: () => {},
				},
			),
		);
		return { open, info, answerApproval };
	}
	const section = () => document.querySelector(".needs-you");
	const buttonIn = (card: Element, label: string) => {
		const found = [...card.querySelectorAll("button")].find(
			(button) => button.textContent === label,
		);
		if (!found) throw new Error(`Missing ${label}: ${card.textContent}`);
		return found;
	};

	it("is absent while nothing waits, and the list below keeps its rows", () => {
		draw([session("working", "working"), session("idle", "waiting")]);
		expect(section()).toBeNull();
		expect(document.querySelectorAll(".session-row")).toHaveLength(1);
	});

	it("says on the agent's row when it continues instead of listing it", () => {
		const at = Date.now() + 600_000;
		draw([session("limited", "error", { presentation: { continuesAtMs: at } })]);
		expect(section()).toBeNull();
		const meta = document.querySelector(".session-row .session-row__meta");
		expect(meta?.firstElementChild?.textContent).toBe(continuesText(at, Date.now()));

		draw([session("limited", "error")]);
		expect(section()).not.toBeNull();
	});

	it("shows the agent, its project and the approval it asks, with Allow once and Deny", () => {
		const { answerApproval, open } = draw([
			session("approve-me", "blocked", { presentation: { approval } }),
			session("ask-me", "input"),
		]);
		expect(section()?.querySelector(".group-heading")?.textContent).toBe(
			`${t("home.needsYou.title")}2`,
		);
		const [first, second] = document.querySelectorAll(".needs-you__card");
		expect(first.querySelector(".home-card__agent")?.textContent).toBe("Agent approve-me");
		expect(first.querySelector(".home-card__project")?.textContent).toBe("Dure");
		expect(first.querySelector(".needs-you__ask")?.textContent).toBe(
			t("chat.approval.title", { tool: "Bash" }),
		);
		expect(first.querySelector(".needs-you__summary")?.textContent).toBe("cargo test -p dure");
		// Allow once and Deny only: "don't ask again" stays with the chat and terminal.
		expect([...first.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
			t("home.needsYou.open"),
			t("home.needsYou.deny"),
			t("home.needsYou.approve"),
		]);
		buttonIn(first, t("home.needsYou.approve")).click();
		buttonIn(first, t("home.needsYou.deny")).click();
		expect(answerApproval.mock.calls.map(([card, choice]) => [card.view.row.sessionId, choice])).toEqual([
			["approve-me", "approve"],
			["approve-me", "deny"],
		]);

		expect(second.querySelector(".needs-you__ask")?.textContent).toBe(t("home.needsYou.input"));
		buttonIn(second, t("home.needsYou.reply")).click();
		expect(open).toHaveBeenCalledWith(expect.objectContaining({ kind: "hub", hubId: "qa-hub" }));
		expect(open.mock.calls[0][0].session.session_id).toBe("ask-me");
	});

	it("says the agent waits without inventing a request it was not given", () => {
		draw([session("plan", "blocked")]);
		const card = document.querySelector(".needs-you__card")!;
		expect(card.querySelector(".needs-you__ask")?.textContent).toBe(t("home.needsYou.approval"));
		expect([...card.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
			t("home.needsYou.open"),
		]);
	});

	it("says why an agent stopped, and leads an exited one to its details instead of attaching", () => {
		const exit = (code: string) => ({ code, terminal_epoch: "epoch-gone", occurred_unix_ms: String(now) });
		const { open, info } = draw([
			session("broke", "error"),
			session("gone", "exited", { ready: false, terminal_epoch: "epoch-gone", failure: exit("provider_exited") }),
		]);
		const broke = document.querySelector('[data-needs-you="broke"]')!;
		expect(broke.querySelector(".needs-you__ask")?.textContent).toBe(t("home.needsYou.error"));
		buttonIn(broke, t("home.needsYou.open")).click();
		expect(open.mock.calls[0][0].session.session_id).toBe("broke");

		const gone = document.querySelector('[data-needs-you="gone"]')!;
		expect(gone.querySelector(".needs-you__ask")?.textContent).toBe(t("home.needsYou.unexpectedExit"));
		expect([...gone.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
			t("sessionInfo.action"),
		]);
		buttonIn(gone, t("sessionInfo.action")).click();
		expect(info).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "gone" }));
		expect(open).toHaveBeenCalledTimes(1);

		draw([
			session("signed-out", "exited", {
				ready: false,
				terminal_epoch: "epoch-gone",
				failure: exit("provider_exited_at_sign_in"),
			}),
		]);
		expect(document.querySelector(".needs-you__ask")?.textContent).toBe(t("home.needsYou.signInExit"));
	});

	it("holds the buttons while an answer is out, names a refusal, and leaves once one landed", () => {
		const sessions = [session("approve-me", "blocked", { presentation: { approval } })];
		draw(sessions, { [approval.attentionId]: { attentionId: approval.attentionId, state: "sending" } });
		const card = document.querySelector(".needs-you__card")!;
		expect(buttonIn(card, t("home.needsYou.approve")).disabled).toBe(true);

		draw(sessions, {
			[approval.attentionId]: {
				attentionId: approval.attentionId,
				state: "failed",
				problem: "chat.approval.changed",
			},
		});
		expect(document.querySelector(".needs-you__problem")?.textContent).toBe(
			t("chat.approval.changed"),
		);

		draw(sessions, { [approval.attentionId]: { attentionId: approval.attentionId, state: "sent" } });
		expect(section()).toBeNull();
	});
});

describe("answering from home", () => {
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
	/** Microtasks and the biometric plugin's dynamic import, without moving the catalog clock. */
	async function settle(): Promise<void> {
		for (let i = 0; i < 5; i += 1) {
			await vi.dynamicImportSettled();
			for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
		}
	}
	let root: HTMLElement;
	let dispose: (() => void) | undefined;
	/** The native side's channel for alert taps and actions. */
	let activate: ((activation: PushActivation) => void) | undefined;
	const waiting = session("approve-me", "blocked", { presentation: { approval } });
	const card = () => root.querySelector('[data-needs-you="approve-me"]');
	const press = (label: string) => {
		const found = [...(card()?.querySelectorAll("button") ?? [])].find(
			(button) => button.textContent === label,
		);
		if (!found) throw new Error(`Missing ${label}: ${root.textContent}`);
		found.click();
	};

	beforeEach(() => {
		vi.useFakeTimers();
		vi.clearAllMocks();
		localStorage.clear();
		saveSettingsPreferences({ ...DEFAULT_SETTINGS_PREFERENCES, approvalBiometric: true });
		Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
		native.hubList.mockResolvedValue([hub]);
		native.hubLayouts.mockResolvedValue({});
		native.listServers.mockResolvedValue({ version: 3, servers: [] });
		native.takeSessionCensus.mockResolvedValue([]);
		native.hubOpen.mockResolvedValue(probe([waiting]));
		native.hubAgentApprovalAnswer.mockResolvedValue({ state: "written_to_pty", record_id: "r" });
		biometric.authenticate.mockResolvedValue(undefined);
		native.pushAlertActions.mockResolvedValue(undefined);
		native.pushActivations.mockImplementation(async (listener: (activation: PushActivation) => void) => {
			activate = listener;
		});
		activate = undefined;
		root = document.createElement("div");
		document.body.replaceChildren(root);
	});
	afterEach(() => {
		dispose?.();
		dispose = undefined;
		root.remove();
		vi.useRealTimers();
	});

	it("answers past Face ID with the exact approval, then the card leaves as the agent moves on", async () => {
		dispose = startApp(root);
		await settle();
		expect(card()).not.toBeNull();

		press(t("home.needsYou.approve"));
		await settle();
		expect(biometric.authenticate).toHaveBeenCalledTimes(1);
		expect(native.hubAgentApprovalAnswer).toHaveBeenCalledWith(
			"qa-hub",
			{ boxId: "this-laptop", workspaceId: "qa", sessionId: "approve-me" },
			"epoch-approve-me",
			"attention-7",
			"approve",
		);
		// Landed: gone at once, and the agent's next catalog read keeps it gone.
		expect(card()).toBeNull();
		native.hubOpen.mockResolvedValue(probe([session("approve-me", "working")]));
		await vi.advanceTimersByTimeAsync(2_000);
		expect(root.querySelector(".needs-you")).toBeNull();
		expect(root.querySelector('[data-session-id="approve-me"]')).not.toBeNull();
	});

	it("sends nothing when the sheet is cancelled, and says so", async () => {
		biometric.authenticate.mockRejectedValue("userCancel");
		dispose = startApp(root);
		await settle();

		press(t("home.needsYou.deny"));
		await settle();
		expect(native.hubAgentApprovalAnswer).not.toHaveBeenCalled();
		expect(root.querySelector(".toast--destructive")?.textContent).toBe(
			t("approval.biometricCancelled"),
		);
		// Still waiting, and answerable again.
		expect(card()).not.toBeNull();
	});

	/** #625: the alert's actions mirror the sheet's preference and the app's copy. */
	it("registers the alert's Allow once, Deny and Reply with the approval preference and their copy", async () => {
		dispose = startApp(root);
		await settle();
		expect(native.pushAlertActions).toHaveBeenCalledWith({
			ownerCheck: true,
			details: true,
			approve: t("home.needsYou.approve"),
			deny: t("home.needsYou.deny"),
			failed: t("notifications.push.answer.failed"),
			reply: t("home.needsYou.reply"),
			send: t("chat.composer.send"),
			placeholder: t("chat.composer.placeholder"),
			replyFailed: t("notifications.push.reply.failed"),
		});
	});

	/** #625: with Face ID on, an alert's action opens the app and answers past the sheet. */
	it("answers an alert's Allow once through the card's path, past Face ID", async () => {
		dispose = startApp(root);
		await settle();
		activate?.({
			hub: "qa-hub",
			sessionId: "approve-me",
			answer: { choice: "approve", attentionId: "attention-7", terminalEpoch: "epoch-approve-me" },
		});
		await settle();
		expect(biometric.authenticate).toHaveBeenCalledTimes(1);
		expect(native.hubAgentApprovalAnswer).toHaveBeenCalledWith(
			"qa-hub",
			{ boxId: "this-laptop", workspaceId: "qa", sessionId: "approve-me" },
			"epoch-approve-me",
			"attention-7",
			"approve",
		);
		expect(card()).toBeNull();
	});

	it("answers nothing for an alert whose approval was replaced, or that another computer raised, and says so", async () => {
		dispose = startApp(root);
		await settle();
		const reads = native.hubOpen.mock.calls.length;
		for (const [hub, answer] of [
			["qa-hub", { choice: "deny", attentionId: "attention-6", terminalEpoch: "epoch-approve-me" }],
			["qa-hub", { choice: "deny", attentionId: "attention-7", terminalEpoch: "epoch-earlier" }],
			// The very approval, but the alert came from another computer.
			["other-hub", { choice: "deny", attentionId: "attention-7", terminalEpoch: "epoch-approve-me" }],
		] as const) {
			activate?.({ hub, sessionId: "approve-me", answer });
			await settle();
		}
		// Each press read the list once more before giving up.
		expect(native.hubOpen.mock.calls.length).toBe(reads + 3);
		expect(biometric.authenticate).not.toHaveBeenCalled();
		expect(native.hubAgentApprovalAnswer).not.toHaveBeenCalled();
		expect(root.textContent).toContain(t("notifications.push.answer.gone"));
		expect(card()).not.toBeNull();
	});

	it("keeps the card with the reason when the computer refuses the answer", async () => {
		native.hubAgentApprovalAnswer.mockResolvedValue({ state: "refused", code: "attention_changed" });
		dispose = startApp(root);
		await settle();

		press(t("home.needsYou.deny"));
		await settle();
		expect(native.hubAgentApprovalAnswer).toHaveBeenCalledWith(
			"qa-hub",
			expect.anything(),
			"epoch-approve-me",
			"attention-7",
			"deny",
		);
		expect(card()?.querySelector(".needs-you__problem")?.textContent).toBe(
			t("chat.approval.changed"),
		);
	});
});
