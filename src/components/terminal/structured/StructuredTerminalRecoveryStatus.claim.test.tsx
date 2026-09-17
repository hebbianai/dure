// @vitest-environment jsdom
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
