import { describe, expect, it, vi } from "vitest";
import { invokePaneAction, registerPaneActions } from "./paneActionRegistry";

describe("declared pane action execution", () => {
	it("keeps legacy handlers argument-free and does not publish their private return values", async () => {
		const run = vi.fn(async () => ({ token: "private-test-value" }));
		const remove = registerPaneActions({ owner: {}, paneId: "legacy-pane", status: "idle", actions: { resume: run } });
		try {
			expect(await invokePaneAction("legacy-pane", "resume", { value: "high" })).toMatchObject({ ok: false });
			expect(run).not.toHaveBeenCalled();
			expect(await invokePaneAction("legacy-pane", "constructor")).toMatchObject({ ok: false });
			expect(await invokePaneAction("legacy-pane", "resume", {})).toEqual({ ok: true, paneId: "legacy-pane", action: "resume" });
			expect(run).toHaveBeenCalledWith();
		} finally { remove(); }
	});
	it("delivers parameters and returns the actual applied result", async () => {
		const applied = {
			outcome: "applied",
			value: { effort: "high", conversationId: "same-chat" },
		};
		const run = vi.fn(async (_input?: unknown) => applied);
		const handler = Object.assign(run, {
			definition: {
				description: "Change reasoning effort",
				parameters: {
					value: { type: "string", values: ["high", "low"], required: true },
				},
			} as const,
		});
		const remove = registerPaneActions({ owner: {},
			paneId: "parameter-pane",
			status: "idle",
			actions: { effort: handler },
		});
		try {
			const result = await invokePaneAction("parameter-pane", "effort", {
				value: "high",
			});
			expect(run).toHaveBeenCalledWith({ value: "high" });
			expect(result).toMatchObject({ ok: true, result: applied });
		} finally {
			remove();
		}
	});

	it("does not report a retained source as an applied action", async () => {
		const refusal = {
			outcome: "refused",
			error: {
				code: "agent_runtime_source_retained",
				message: "The source remains selected.",
				retryable: true,
			},
		};
		const handler = Object.assign(async () => refusal, {
			definition: { description: "Change reasoning effort", parameters: {} },
		});
		const remove = registerPaneActions({ owner: {},
			paneId: "retained-pane",
			status: "idle",
			actions: { effort: handler },
		});
		try {
			expect(await invokePaneAction("retained-pane", "effort")).toMatchObject({
				ok: true,
				result: refusal,
			});
		} finally {
			remove();
		}
	});
});
