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
		expect(activatedRow(rows, { sessionId: "agent-chat" })).toBe(rows[1]);
	});

	it("finds nothing the phone cannot open: unlisted, ended or on an unreachable computer", () => {
		const rows = [row("ended", { ready: false }), row("away", { reachable: false })];
		for (const sessionId of ["missing", "ended", "away"]) {
			expect(activatedRow(rows, { sessionId })).toBeUndefined();
		}
	});
});

describe("activatedApproval", () => {
	const card = (sessionId: string, attentionId: string, choices = ["approve", "deny"]): NeedsYouCard => {
		const view = row(sessionId);
		(view.source.session as { terminal_epoch: string }).terminal_epoch = "7";
		return {
			view: { row: view },
			wait: "approval",
			approval: { attentionId, request: { toolName: "Bash", choices } },
		} as unknown as NeedsYouCard;
	};
	const press = (attentionId: string, choice: "approve" | "deny" = "approve", terminalEpoch = "7") => ({
		sessionId: "managed_a",
		answer: { choice, attentionId, terminalEpoch },
	});

	it("finds the card waiting on the very approval the alert named", () => {
		const cards = [card("managed_b", "attention-3"), card("managed_a", "attention-3")];
		expect(activatedApproval(cards, press("attention-3"))).toBe(cards[1]);
	});

	it("finds nothing for a tap, a replaced approval, a restarted process or an answer not offered", () => {
		const cards = [card("managed_a", "attention-3", ["approve"])];
		expect(activatedApproval(cards, { sessionId: "managed_a" })).toBeUndefined();
		expect(activatedApproval(cards, press("attention-4"))).toBeUndefined();
		expect(activatedApproval(cards, press("attention-3", "approve", "8"))).toBeUndefined();
		expect(activatedApproval(cards, press("attention-3", "deny"))).toBeUndefined();
	});
});
