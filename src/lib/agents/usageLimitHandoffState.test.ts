import { expect, it } from "vitest";
import { usageLimitHandoffState as state } from "./usageLimitHandoffState";

it("permits explicit recovery after failure while duplicate observers cannot retry automatically", () => {
	const agentId = "handoff-state-recovery";
	const first = state.begin(agentId, 10, "automatic")!;
	expect(state.begin(agentId, 10, "automatic")).toBeUndefined();
	expect(state.begin(agentId, 10, "requested")).toBeUndefined();
	state.settle(first, { kind: "failed", error: "account unavailable" });
	expect(state.read(agentId, 10)?.result).toEqual({
		kind: "failed",
		error: "account unavailable",
	});
	expect(state.begin(agentId, 10, "automatic")).toBeUndefined();
	const recovery = state.begin(agentId, 10, "requested")!;
	expect(recovery).toBeDefined();
	expect(state.begin(agentId, 10, "requested")).toBeUndefined();
	state.settle(first, { kind: "completed", outcome: { toName: "obsolete" } });
	expect(state.read(agentId, 10)?.result).toEqual({ kind: "pending" });
	state.settle(recovery, { kind: "completed", outcome: { toName: "replacement" } });
	expect(state.read(agentId, 10)?.result).toEqual({
		kind: "completed",
		outcome: { toName: "replacement" },
	});
	expect(state.begin(agentId, 10, "requested")).toBeUndefined();
});

it("keeps a newer failure visible when an older transition settles late", () => {
	const agentId = "handoff-state-successor";
	const first = state.begin(agentId, 10, "automatic")!;
	const second = state.begin(agentId, 20, "automatic")!;
	state.settle(second, { kind: "failed", error: "new failure" });
	const revision = state.revision();
	state.settle(first, { kind: "completed", outcome: { toName: "old account" } });
	expect(state.revision()).toBe(revision);
	expect(state.read(agentId, 20)?.result).toEqual({
		kind: "failed",
		error: "new failure",
	});
	expect(state.begin(agentId, 10, "automatic")).toBeUndefined();
	expect(state.begin(agentId, 10, "requested")).toBeUndefined();
	expect(state.read(agentId, 30)).toBeUndefined();
});
