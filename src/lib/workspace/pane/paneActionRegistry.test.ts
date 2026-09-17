import { describe, expect, it, vi } from "vitest";
import {
	beginPaneActionProgress,
	invokePaneAction,
	paneActionPending,
	paneActionSnapshot,
	registerPaneActions,
} from "@/lib/workspace/pane/paneActionRegistry";

describe("paneActionRegistry", () => {
	it("retains action progress across handler replacement without overwriting runtime status", () => {
		const paneId = "term:progress";
		const finish = beginPaneActionProgress(paneId, "rehost");
		const dispose = registerPaneActions({ owner: {}, paneId, status: "attach_failed", error: "closed", actions: {} });
		try {
			expect(paneActionPending(paneId, "rehost")).toBe(true);
			expect(paneActionPending("term:other", "rehost")).toBe(false);
			expect(paneActionSnapshot(paneId)?.status).toBe("attach_failed");
			dispose();
			expect(paneActionPending(paneId, "rehost")).toBe(true);
		} finally {
			finish();
			dispose();
		}
		expect(paneActionPending(paneId, "rehost")).toBe(false);
	});

	it("exposes the registered status, context, and action names", () => {
		const unregister = registerPaneActions({ owner: {},
			paneId: "agent:agent-1",
			status: "attach_failed",
			error: "connect failed",
			context: "agent=agent-1 pane=agent:agent-1",
			actions: { resume: async () => {} },
		});
		try {
			expect(paneActionSnapshot("agent:agent-1")).toEqual({
				paneId: "agent:agent-1",
				status: "attach_failed",
				error: "connect failed",
				context: "agent=agent-1 pane=agent:agent-1",
				actions: ["resume"],
			});
		} finally {
			unregister();
		}
		expect(paneActionSnapshot("agent:agent-1")).toBeUndefined();
	});

	it("prefers the entry needing recovery over a healthy duplicate", () => {
		const healthy = registerPaneActions({ owner: {},
			paneId: "term:s1",
			status: "attached",
			actions: {},
		});
		const failing = registerPaneActions({ owner: {},
			paneId: "term:s1",
			status: "attach_failed",
			error: "ENOENT",
			actions: { resume: async () => {} },
		});
		try {
			expect(paneActionSnapshot("term:s1")?.status).toBe("attach_failed");
		} finally {
			failing();
		}
		try {
			expect(paneActionSnapshot("term:s1")?.status).toBe("attached");
		} finally {
			healthy();
		}
	});

	it("composes an action-only surface without replacing pane status", () => {
		const status = registerPaneActions({ owner: {},
			paneId: "term:composed",
			status: "attach_failed",
			error: "ENOENT",
			actions: { resume: async () => {} },
		});
		const header = registerPaneActions({ owner: {},
			paneId: "term:composed",
			actions: { rehost: async () => {} },
		});
		try {
			expect(paneActionSnapshot("term:composed")).toMatchObject({
				status: "attach_failed",
				error: "ENOENT",
				actions: ["resume", "rehost"],
			});
		} finally {
			header();
			status();
		}
	});

	it("invokes the exact registered handler and reports success", async () => {
		const resume = vi.fn().mockResolvedValue(undefined);
		const unregister = registerPaneActions({ owner: {},
			paneId: "agent:agent-2",
			status: "attach_failed",
			actions: { resume },
		});
		try {
			await expect(invokePaneAction("agent:agent-2", "resume")).resolves.toEqual(
				{ ok: true, paneId: "agent:agent-2", action: "resume" },
			);
			expect(resume).toHaveBeenCalledTimes(1);
		} finally {
			unregister();
		}
	});

	it("refuses an unknown pane with a typed, non-retryable error", async () => {
		const result = await invokePaneAction("agent:missing", "resume");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("pane_not_found");
			expect(result.error.retryable).toBe(false);
			expect(result.error.nextAction).toContain("dure ls");
		}
	});

	it("refuses an unknown action and names the available ones", async () => {
		const unregister = registerPaneActions({ owner: {},
			paneId: "agent:agent-3",
			status: "attach_failed",
			actions: { resume: async () => {} },
		});
		try {
			const result = await invokePaneAction("agent:agent-3", "explode");
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error.code).toBe("pane_action_unavailable");
				expect(result.error.nextAction).toContain("resume");
			}
		} finally {
			unregister();
		}
	});

	it("maps a thrown handler into a retryable typed failure", async () => {
		const unregister = registerPaneActions({ owner: {},
			paneId: "agent:agent-4",
			status: "attach_failed",
			actions: {
				resume: async () => {
					throw new Error("host refused");
				},
			},
		});
		try {
			const result = await invokePaneAction("agent:agent-4", "resume");
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error).toEqual({
					code: "pane_action_failed",
					message: "host refused",
					retryable: true,
					nextAction:
						"re-run `dure client pane state agent:agent-4` and retry",
				});
			}
		} finally {
			unregister();
		}
	});
});
