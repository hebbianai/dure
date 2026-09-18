import { afterEach, expect, it, vi } from "vitest";
import {
	type CliPaneActionDependencies,
	dispatchCliPaneActionRequest,
} from "@/lib/cli/cliPaneActions";
import { terminalPaneInputAction } from "@/lib/terminal/interaction/terminalPaneInputAction";
import { registerPaneActions } from "@/lib/workspace/pane/paneActionRegistry";

vi.mock("@/lib/cli/cliPaneDiagnostics", () => ({
	readCliPaneDiagnostics: (paneId: string) => ({ inspectedPaneId: paneId }),
}));

const dispose: (() => void)[] = [];
afterEach(() => {
	for (const unregister of dispose.splice(0)) unregister();
});

function mount(
	paneId: string,
	send: Parameters<typeof terminalPaneInputAction>[0],
	context: string,
) {
	const unregister = registerPaneActions({
		paneId,
		status: "attached",
		context,
		owner: {},
		actions: { "terminal.input": terminalPaneInputAction(send) },
	});
	dispose.push(unregister);
	return unregister;
}

for (const paneId of ["pane-stable-slot", "agent:historical-slot"]) {
	it(`does not retarget input after ${paneId} changes during asynchronous claim`, async () => {
		const original = vi.fn(async () => {});
		const replacement = vi.fn(async () => {});
		const unmount = mount(paneId, original, "session=original");
		const complete = vi.fn<CliPaneActionDependencies["complete"]>(
			async () => {},
		);
		await dispatchCliPaneActionRequest(
			{
				reqId: "same-request",
				action: "pane.act",
				params: {
					targetPanelId: paneId,
					actionId: "terminal.input",
					arguments: { text: "original task", appendEnter: true },
				},
			},
			{
				async claim() {
					unmount();
					mount(paneId, replacement, "session=replacement");
					return true;
				},
				complete,
				isFallbackWindow: () => true,
				delay: async () => {},
			},
		);
		expect(replacement).not.toHaveBeenCalled();
		expect(original).not.toHaveBeenCalled();
		expect(complete.mock.calls[0][1]).toMatchObject({ ok: false });
	});

	it(`observes the newest state after ${paneId} changes during asynchronous claim`, async () => {
		const unmount = mount(
			paneId,
			vi.fn(async () => {}),
			"session=original",
		);
		const complete = vi.fn<CliPaneActionDependencies["complete"]>(
			async () => {},
		);
		await dispatchCliPaneActionRequest(
			{
				reqId: "observe-request",
				action: "pane.state",
				params: { targetPanelId: paneId },
			},
			{
				async claim() {
					unmount();
					mount(
						paneId,
						vi.fn(async () => {}),
						"session=replacement",
					);
					return true;
				},
				complete,
				isFallbackWindow: () => true,
				delay: async () => {},
			},
		);
		expect(complete.mock.calls[0][1]).toMatchObject({
			ok: true,
			pane: { context: "session=replacement" },
		});
	});
}

it("executes once when the same mounted recipient survives the claim", async () => {
	const send = vi.fn(async () => {});
	const paneId = "pane-unchanged";
	mount(paneId, send, "session=original");
	const complete = vi.fn<CliPaneActionDependencies["complete"]>(async () => {});
	await dispatchCliPaneActionRequest(
		{
			reqId: "unchanged-request",
			action: "pane.act",
			params: {
				targetPanelId: paneId,
				actionId: "terminal.input",
				arguments: { text: "one task" },
			},
		},
		{
			claim: async () => true,
			complete,
			isFallbackWindow: () => true,
			delay: async () => {},
		},
	);
	expect(send).toHaveBeenCalledOnce();
	expect(complete.mock.calls[0][1]).toMatchObject({ ok: true });
});

it("does not execute a request already claimed by another window", async () => {
	const send = vi.fn(async () => {});
	const paneId = "pane-duplicate";
	mount(paneId, send, "session=original");
	const complete = vi.fn<CliPaneActionDependencies["complete"]>(async () => {});
	await dispatchCliPaneActionRequest(
		{
			reqId: "duplicate-request",
			action: "pane.act",
			params: {
				targetPanelId: paneId,
				actionId: "terminal.input",
				arguments: { text: "one task" },
			},
		},
		{
			claim: async () => false,
			complete,
			isFallbackWindow: () => true,
			delay: async () => {},
		},
	);
	expect(send).not.toHaveBeenCalled();
	expect(complete).not.toHaveBeenCalled();
});

for (const action of ["pane.state", "pane.act"]) {
	it(`answers ${action} when its local pane mounts during ownership discovery`, async () => {
		const send = vi.fn(async () => {});
		const complete = vi.fn<CliPaneActionDependencies["complete"]>(
			async () => {},
		);
		const claim = vi.fn(async () => true);
		await dispatchCliPaneActionRequest(
			{
				reqId: "cold-mount",
				action,
				params: {
					targetPanelId: "cold-pane",
					actionId: "terminal.input",
					arguments: { text: "once" },
				},
			},
			{
				claim,
				complete,
				isFallbackWindow: () => true,
				delay: async () => {
					mount("cold-pane", send, "session=cold");
				},
			},
		);
		expect(claim).toHaveBeenCalledOnce();
		expect(complete.mock.calls[0]?.[1]).toMatchObject({ ok: true });
		expect(send).toHaveBeenCalledTimes(action === "pane.act" ? 1 : 0);
	});
}
