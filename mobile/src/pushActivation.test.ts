import { describe, expect, it } from "vitest";
import type { UnifiedRow, UnifiedSource } from "./allSessions";
import { activatedRow } from "./pushActivation";

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
