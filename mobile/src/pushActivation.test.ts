import { describe, expect, it } from "vitest";
import type { UnifiedRow, UnifiedSource } from "./allSessions";
import type { NeedsYouCard } from "./homeProjection";
import { activatedApproval, activatedRow } from "./pushActivation";

function row(sessionId: string, source: Partial<Extract<UnifiedSource, { kind: "hub" }>> & { ready?: boolean } = {}): UnifiedRow {
	const { ready = true, ...hub } = source;
	return {
		sessionId,
		title: sessionId,
		state: "run",
		agent: "claude",
		label: "Claude",
		project: "",
		order: 0,
		source: {
			kind: "hub",
			hubId: "hub-1",
			hubLabel: "Laptop",
			reachable: true,
			session: { session_id: sessionId, ready } as Extract<UnifiedSource, { kind: "hub" }>["session"],
			...hub,
		},
	} as UnifiedRow;
}

describe("activatedRow", () => {
	it("finds the row the alert's agent key names", () => {
		const rows = [row("managed_a"), row("agent-chat")];
		expect(activatedRow(rows, { hub: "hub-1", sessionId: "agent-chat" })).toBe(rows[1]);
	});

	it("finds nothing the phone cannot open: unlisted, ended or on an unreachable computer", () => {
		const rows = [row("ended", { ready: false }), row("away", { reachable: false })];
		for (const sessionId of ["missing", "ended", "away"]) {
			expect(activatedRow(rows, { hub: "hub-1", sessionId })).toBeUndefined();
		}
	});

	it("opens the agent on the computer the alert came from, not one with the same key elsewhere", () => {
		const rows = [row("managed_a"), row("managed_a", { hubId: "hub-2", hubLabel: "Desktop" })];
		expect(activatedRow(rows, { hub: "hub-2", sessionId: "managed_a" })).toBe(rows[1]);
		expect(activatedRow(rows, { hub: "hub-3", sessionId: "managed_a" })).toBeUndefined();
	});
});

describe("activatedApproval", () => {
	const card = (sessionId: string, attentionId: string, choices = ["approve", "deny"], hubId = "hub-1"): NeedsYouCard => {
		const view = row(sessionId, { hubId });
		(view.source.session as { terminal_epoch: string }).terminal_epoch = "7";
		return {
			view: { row: view },
			wait: "approval",
			approval: { attentionId, request: { toolName: "Bash", choices } },
		} as unknown as NeedsYouCard;
	};
	const press = (attentionId: string, choice: "approve" | "deny" = "approve", terminalEpoch = "7", hub = "hub-1") => ({
		hub,
		sessionId: "managed_a",
		answer: { choice, attentionId, terminalEpoch },
	});

	it("finds the card waiting on the very approval the alert named", () => {
		const cards = [card("managed_b", "attention-3"), card("managed_a", "attention-3")];
		expect(activatedApproval(cards, press("attention-3"))).toBe(cards[1]);
	});

	it("finds nothing for a tap, a replaced approval, a restarted process or an answer not offered", () => {
		const cards = [card("managed_a", "attention-3", ["approve"])];
		expect(activatedApproval(cards, { hub: "hub-1", sessionId: "managed_a" })).toBeUndefined();
		expect(activatedApproval(cards, press("attention-4"))).toBeUndefined();
		expect(activatedApproval(cards, press("attention-3", "approve", "8"))).toBeUndefined();
		expect(activatedApproval(cards, press("attention-3", "deny"))).toBeUndefined();
	});

	it("answers only the card from the computer the alert came from", () => {
		const cards = [card("managed_a", "attention-3"), card("managed_a", "attention-3", ["approve", "deny"], "hub-2")];
		expect(activatedApproval(cards, press("attention-3", "approve", "7", "hub-2"))).toBe(cards[1]);
		expect(activatedApproval(cards, press("attention-3", "approve", "7", "hub-3"))).toBeUndefined();
	});
});
