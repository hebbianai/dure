import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type CliPaneActionDependencies,
	dispatchCliPaneActionRequest,
} from "@/lib/cli/cliPaneActions";
import { registerPaneActions } from "@/lib/workspace/pane/paneActionRegistry";
import { definePaneAction } from "@/lib/workspace/pane/paneAction";

vi.mock("./cliPaneDiagnostics", () => ({
	readCliPaneDiagnostics: (paneId: string) => ({ inspectedPaneId: paneId }),
}));

function dependencies(
	overrides: Partial<CliPaneActionDependencies> = {},
): CliPaneActionDependencies & {
	complete: ReturnType<typeof vi.fn>;
	claim: ReturnType<typeof vi.fn>;
} {
	return {
		claim: vi.fn().mockResolvedValue(true),
		complete: vi.fn().mockResolvedValue(undefined),
		isFallbackWindow: () => true,
		delay: () => Promise.resolve(),
		...overrides,
	} as never;
}

let unregister: (() => void) | undefined;

beforeEach(() => {
	unregister?.();
	unregister = undefined;
});

describe("dispatchCliPaneActionRequest", () => {
	it("marks an unmounted action as not started and describes recovery with a new key", async () => {
		const deps = dependencies();
		await dispatchCliPaneActionRequest(
			{
				reqId: "not-mounted-action",
				action: "pane.act",
				params: { targetPanelId: "mobile:missing", actionId: "mobile.install" },
			},
			deps,
		);
		const [, payload] = deps.complete.mock.calls[0];
		expect(payload).toMatchObject({
			ok: false,
			error: {
				code: "pane_not_found",
				execution: "not_started",
				retryable: false,
			},
		});
		expect(payload.error.nextAction).toContain("new idempotency key");
		expect(payload.error.nextAction).toContain("pane state");
	});
	it("delivers action arguments and preserves the public domain result in the HTTP completion", async () => {
		const applied = { outcome: "applied" as const, value: { conversationId: "original", selectionRevision: 13 } };
		const run = vi.fn(async () => applied);
		unregister = registerPaneActions({ owner: {}, paneId: "agent:parameterized", status: "attached", actions: {
			"settings.effort": definePaneAction({ description: "Effort", parameters: { value: { type: "string", required: true } } }, run),
		} });
		const deps = dependencies();
		await dispatchCliPaneActionRequest({ reqId: "parameter-request", action: "pane.act", params: {
			targetPanelId: "agent:parameterized", actionId: "settings.effort", arguments: { value: "high" },
		} }, deps);
		expect(run).toHaveBeenCalledWith({ value: "high" });
		expect(deps.complete).toHaveBeenCalledWith("parameter-request", { ok: true, pane: {
			paneId: "agent:parameterized", invoked: "settings.effort", status: "attached", result: applied,
		} }, "pane.act");
	});
	it("ignores unrelated actions", async () => {
		const deps = dependencies();
		await expect(
			dispatchCliPaneActionRequest(
				{ reqId: "r1", action: "spawn", params: {} },
				deps,
			),
		).resolves.toBe(false);
		expect(deps.claim).not.toHaveBeenCalled();
	});

	it("returns the mounted pane snapshot for pane.state", async () => {
		unregister = registerPaneActions({ owner: {},
			paneId: "agent:agent-1",
			status: "attach_failed",
			error: "ENOENT",
			context: "agent=agent-1",
			actions: { resume: async () => {} },
		});
		const deps = dependencies();
		await dispatchCliPaneActionRequest(
			{
				reqId: "r2",
				action: "pane.state",
				params: { targetPanelId: "agent:agent-1" },
			},
			deps,
		);
		expect(deps.complete).toHaveBeenCalledWith(
			"r2",
			{
				ok: true,
				pane: {
					paneId: "agent:agent-1",
					status: "attach_failed",
					error: "ENOENT",
					context: "agent=agent-1",
					actions: ["resume"],
					diagnostics: { inspectedPaneId: "agent:agent-1" },
				},
			},
			"pane.state",
		);
	});

	it("stays silent for unmounted panes on non-fallback windows", async () => {
		const deps = dependencies({ isFallbackWindow: () => false });
		await expect(
			dispatchCliPaneActionRequest(
				{
					reqId: "r3",
					action: "pane.state",
					params: { targetPanelId: "agent:missing" },
				},
				deps,
			),
		).resolves.toBe(true);
		expect(deps.claim).not.toHaveBeenCalled();
		expect(deps.complete).not.toHaveBeenCalled();
	});

	it("turns silence into a typed not-found on the fallback window", async () => {
		const deps = dependencies();
		await dispatchCliPaneActionRequest(
			{
				reqId: "r4",
				action: "pane.state",
				params: { targetPanelId: "agent:missing" },
			},
			deps,
		);
		const [, payload] = deps.complete.mock.calls[0];
		expect(payload.ok).toBe(false);
		expect(payload.error.code).toBe("pane_not_found");
		expect(payload.error.retryable).toBe(false);
	});

	it("invokes the registered handler for pane.act and reports status", async () => {
		const resume = vi.fn().mockResolvedValue(undefined);
		unregister = registerPaneActions({ owner: {},
			paneId: "agent:agent-5",
			status: "attach_failed",
			actions: { resume },
		});
		const deps = dependencies();
		await dispatchCliPaneActionRequest(
			{
				reqId: "r5",
				action: "pane.act",
				params: { targetPanelId: "agent:agent-5", actionId: "resume" },
			},
			deps,
		);
		expect(resume).toHaveBeenCalledTimes(1);
		expect(deps.complete).toHaveBeenCalledWith(
			"r5",
			{
				ok: true,
				pane: {
					paneId: "agent:agent-5",
					invoked: "resume",
					status: "attach_failed",
				},
			},
			"pane.act",
		);
	});

	it("relays typed refusals from the registry for pane.act", async () => {
		unregister = registerPaneActions({ owner: {},
			paneId: "agent:agent-6",
			status: "attach_failed",
			actions: { resume: async () => {} },
		});
		const deps = dependencies();
		await dispatchCliPaneActionRequest(
			{
				reqId: "r6",
				action: "pane.act",
				params: { targetPanelId: "agent:agent-6", actionId: "explode" },
			},
			deps,
		);
		const [, payload] = deps.complete.mock.calls[0];
		expect(payload.ok).toBe(false);
		expect(payload.error.code).toBe("pane_action_unavailable");
		expect(payload.error.nextAction).toContain("resume");
	});
});
