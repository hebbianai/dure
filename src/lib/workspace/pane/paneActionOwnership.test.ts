import { afterEach, expect, it, vi } from "vitest";
import {
	type CliPaneActionDependencies,
	dispatchCliPaneActionRequest,
} from "@/lib/cli/cliPaneActions";
import { definePaneAction } from "@/lib/workspace/pane/paneAction";
import {
	type PaneActionEntry,
	registerPaneActions,
} from "@/lib/workspace/pane/paneActionRegistry";

vi.mock("@/lib/cli/cliPaneDiagnostics", () => ({
	readCliPaneDiagnostics: () => ({}),
}));

const cleanups: (() => void)[] = [];
const paneId = "pane-owner-lifetime";
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});
function mount(
	owner: object,
	actions: PaneActionEntry["actions"],
	status = false,
) {
	const remove = registerPaneActions({
		paneId,
		owner,
		actions,
		...(status ? { status: "attached" as const } : {}),
	});
	cleanups.push(remove);
	return remove;
}
function request(
	overrides: Partial<CliPaneActionDependencies> = {},
	action = "run",
) {
	const complete = vi.fn<CliPaneActionDependencies["complete"]>(async () => {});
	const promise = dispatchCliPaneActionRequest(
		{
			reqId: "owner-request",
			action: "pane.act",
			params: { targetPanelId: paneId, actionId: action },
		},
		{
			claim: async () => true,
			complete,
			isFallbackWindow: () => false,
			delay: async () => {},
			...overrides,
		},
	);
	return { complete, promise };
}

it("refuses a new recipient even when it reuses the exact same function", async () => {
	const run = vi.fn(async () => {});
	const remove = mount({}, { run }, true);
	const result = request({
		claim: async () => {
			remove();
			mount({}, { run }, true);
			return true;
		},
	});
	await result.promise;
	expect(run).not.toHaveBeenCalled();
	expect(result.complete.mock.calls[0][1]).toMatchObject({ ok: false });
});

it("updates a handler for the same owner without invoking the stale callback", async () => {
	const owner = {};
	const before = vi.fn(async () => {});
	const after = vi.fn(async () => {});
	const remove = mount(owner, { run: before }, true);
	const result = request({
		claim: async () => {
			remove();
			mount(owner, { run: after }, true);
			return true;
		},
	});
	await result.promise;
	expect(before).not.toHaveBeenCalled();
	expect(after).toHaveBeenCalledOnce();
	expect(result.complete.mock.calls[0][1]).toMatchObject({ ok: true });
});

it("does not let a status-only contribution replace a composed action owner", async () => {
	const run = vi.fn(async () => {});
	mount({}, { run }, true);
	const result = request({
		claim: async () => {
			const remove = registerPaneActions({
				paneId,
				owner: {},
				status: "attach_failed",
				error: "display refresh",
				actions: {},
			});
			cleanups.push(remove);
			return true;
		},
	});
	await result.promise;
	expect(run).toHaveBeenCalledOnce();
	expect(result.complete.mock.calls[0][1]).toMatchObject({ ok: true });
});

it("does not run a newly offered action that was absent at admission", async () => {
	const owner = {};
	const run = vi.fn(async () => {});
	const remove = mount(owner, {}, true);
	const result = request({
		claim: async () => {
			remove();
			mount(owner, { run }, true);
			return true;
		},
	});
	await result.promise;
	expect(run).not.toHaveBeenCalled();
	expect(result.complete.mock.calls[0][1]).toMatchObject({ ok: false });
});

it("does not run a withdrawn action even though the recipient is unchanged", async () => {
	const owner = {};
	const run = vi.fn(async () => {});
	const remove = mount(owner, { run }, true);
	const result = request({
		claim: async () => {
			remove();
			mount(owner, {}, true);
			return true;
		},
	});
	await result.promise;
	expect(run).not.toHaveBeenCalled();
	expect(result.complete.mock.calls[0][1]).toMatchObject({ ok: false });
});

it("preserves an accepted result after the action intentionally replaces its recipient", async () => {
	let remove: () => void;
	const receipt = {
		outcome: "applied" as const,
		value: { successor: "new-runtime" },
	};
	const replacement = vi.fn(async () => {});
	const run = definePaneAction(
		{ description: "Replace this recipient.", parameters: {} },
		async () => {
			remove();
			mount({}, { run: replacement }, true);
			return receipt;
		},
	);
	remove = mount({}, { run }, true);
	const result = request();
	await result.promise;
	expect(replacement).not.toHaveBeenCalled();
	expect(result.complete.mock.calls[0][1]).toMatchObject({
		ok: true,
		pane: { result: receipt },
	});
});

it("keeps claim fencing after execution even when completion delivery is lost", async () => {
	const run = vi.fn(async () => {});
	mount({}, { run }, true);
	let claimed = false;
	const claim = vi.fn(async () => {
		const accepted = !claimed;
		claimed = true;
		return accepted;
	});
	const complete = vi.fn(async () => {
		throw new Error("response lost after completion commit");
	});
	await expect(request({ claim, complete }).promise).rejects.toThrow(
		"response lost",
	);
	await request({ claim, complete }).promise;
	expect(claim).toHaveBeenCalledTimes(2);
	expect(run).toHaveBeenCalledOnce();
	expect(complete).toHaveBeenCalledOnce();
});

it("reports that a pane closed while its state request was being claimed", async () => {
	const remove = mount({}, {}, true);
	const complete = vi.fn<CliPaneActionDependencies["complete"]>(async () => {});
	await dispatchCliPaneActionRequest(
		{
			reqId: "observe-closed",
			action: "pane.state",
			params: { targetPanelId: paneId },
		},
		{
			claim: async () => {
				remove();
				return true;
			},
			complete,
			isFallbackWindow: () => false,
			delay: async () => {},
		},
	);
	expect(complete.mock.calls[0][1]).toMatchObject({
		ok: false,
		error: { code: "pane_not_found" },
	});
});
