// @vitest-environment jsdom
import { invokePaneAction, paneActionSnapshot } from "@/lib/workspace/pane/paneActionRegistry";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { StructuredTerminalRecoveryStatus } from "@/components/terminal/structured/StructuredTerminalRecoveryStatus";
import {
	type CliPaneActionDependencies,
	dispatchCliPaneActionRequest,
} from "@/lib/cli/cliPaneActions";
import type { TerminalAttachRecovery } from "@/lib/terminal/terminalAttachRecovery";

afterEach(cleanup);
const paneId = "pane-recovery";
function recovery(ownerKey: string) {
	return {
		ownerKey,
		intent: "resume" as const,
		context: "same human text",
		resume: vi.fn(async () => {}),
	} satisfies TerminalAttachRecovery;
}
async function request(claim: () => Promise<boolean>) {
	const complete = vi.fn<CliPaneActionDependencies["complete"]>(async () => {});
	let pending: Promise<boolean>;
	act(() => {
		pending = dispatchCliPaneActionRequest(
			{
				reqId: "recover-claim",
				action: "pane.act",
				params: { targetPanelId: paneId, actionId: "resume" },
			},
			{
				claim,
				complete,
				isFallbackWindow: () => false,
				delay: async () => {},
			},
		);
	});
	await act(async () => {
		await pending;
	});
	return complete.mock.calls[0][1];
}

it("does not resume a changed source just because the pane and display text are unchanged", async () => {
	const before = recovery("source-original");
	const after = recovery("source-replacement");
	const view = render(
		<StructuredTerminalRecoveryStatus
			paneId={paneId}
			error="session_exited"
			attachRecovery={before}
		/>,
	);
	const result = await request(async () => {
		act(() =>
			view.rerender(
				<StructuredTerminalRecoveryStatus
					paneId={paneId}
					error="session_exited"
					attachRecovery={after}
				/>,
			),
		);
		return true;
	});
	expect(before.resume).not.toHaveBeenCalled();
	expect(after.resume).not.toHaveBeenCalled();
	expect(result).toMatchObject({ ok: false });
});

it("keeps recovery available across ordinary status and handler refresh for the same source", async () => {
	const before = recovery("same-source");
	const after = recovery("same-source");
	const view = render(
		<StructuredTerminalRecoveryStatus
			paneId={paneId}
			error="session_exited"
			attachRecovery={before}
		/>,
	);
	const result = await request(async () => {
		act(() =>
			view.rerender(
				<StructuredTerminalRecoveryStatus
					paneId={paneId}
					error="same_failure_updated"
					attachRecovery={after}
				/>,
			),
		);
		return true;
	});
	expect(before.resume).not.toHaveBeenCalled();
	expect(after.resume).toHaveBeenCalledOnce();
	expect(result).toMatchObject({ ok: true });
});

it("offers a declared reconnect action and acknowledges only pending attachment", async () => {
	const resume = vi.fn(async () => ({ state: "reconnecting", sessionId: "same-session" }));
	render(<StructuredTerminalRecoveryStatus paneId={paneId} error="decode failed" attachRecovery={{
		ownerKey: "live-source", intent: "reconnect", context: "same-session", resume,
	}} />);
	expect(paneActionSnapshot(paneId)?.actions).toEqual(["reconnect"]);
	expect(paneActionSnapshot(paneId)?.actionDefinitions?.reconnect).toMatchObject({ parameters: {} });
	await act(async () => {
		expect(await invokePaneAction(paneId, "reconnect", { wrong: true })).toMatchObject({ result: { outcome: "refused" } });
	});
	expect(resume).not.toHaveBeenCalled();
	await act(async () => {
		expect(await invokePaneAction(paneId, "reconnect")).toMatchObject({
			ok: true, result: { outcome: "pending", value: { state: "reconnecting", sessionId: "same-session" } },
		});
	});
	expect(resume).toHaveBeenCalledOnce();
});

it("reports connecting until the transport has installed a complete frame", () => {
	const view = render(<StructuredTerminalRecoveryStatus paneId={paneId} connectionPending />);
	expect(paneActionSnapshot(paneId)?.status).toBe("connecting");
	view.rerender(<StructuredTerminalRecoveryStatus paneId={paneId} connectionPending={false} />);
	expect(paneActionSnapshot(paneId)?.status).toBe("attached");
});
