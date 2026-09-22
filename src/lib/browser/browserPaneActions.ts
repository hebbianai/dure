import { definePaneAction } from "../workspace/pane/paneAction";
import type { PaneActionEntry } from "../workspace/pane/paneActionRegistry";
import type { BrowserPaneSession, BrowserPaneView } from "./browserPaneSession";
import type { BrowserControllerLease } from "./browserResourceContract";

/** The mounted pane supplies the same handoff handler to its button and agents. */
export function browserPaneActions({
	paneId,
	session,
	view,
	busy,
	error,
	reconnect,
	take,
}: {
	paneId: string;
	session?: BrowserPaneSession;
	view: BrowserPaneView;
	busy: boolean;
	error?: unknown;
	reconnect: () => void;
	take: (expected: BrowserControllerLease | null) => Promise<void>;
}) {
	const failure = error || view.error;
	const control = view.control;
	const expected = control?.controller;
	const expectedState = JSON.stringify([session?.resource, expected]);
	const unavailable =
		!session ||
		!control ||
		busy ||
		control.phase !== "ready" ||
		!!control.requested_controller;
	// An explicit handback targets this mounted session even in a hidden Space.
	// Visibility still gates page input and viewport fitting in the pane.
	const takeControl = definePaneAction(
		{
			description:
				"Give control to this browser pane. Its viewport fits the pane after transfer.",
			parameters: {
				expectedState: {
					type: "string",
					required: true,
					description: "Copy expectedState from this action's current values.",
				},
			},
			current: { expectedState },
			...(unavailable
				? {
						unavailable: {
							code: "browser_control_unavailable",
							message: "The browser pane is not ready to receive control.",
							retryable: false,
						},
					}
				: {}),
		},
		async (input) => {
			if (input.expectedState !== expectedState || !session || !control)
				return {
					outcome: "refused",
					error: {
						code: "browser_controller_changed",
						message: "Inspect the browser pane again before returning control.",
						retryable: false,
					},
				};
			if (expected?.controller_id === session.controllerId)
				return { outcome: "unchanged" };
			await take(expected ?? null);
			const current = session.read().control;
			if (current?.requested_controller === session.controllerId)
				return { outcome: "pending" };
			if (
				current?.controller?.controller_id === session.controllerId &&
				current.phase === "ready" &&
				!current.requested_controller
			)
				return { outcome: "applied" };
			return {
				outcome: "failed",
				error: {
					code: "browser_control_not_transferred",
					message:
						"Control was not confirmed. Inspect the browser before retrying.",
					retryable: false,
				},
			};
		},
	);
	const reconnectAction = definePaneAction(
		{
			description:
				"Reconnect this browser pane to its saved backend and resource.",
			parameters: {},
			...(busy || view.submitting
				? {
						unavailable: {
							code: "browser_pane_busy",
							message: "Wait for the current browser operation to finish.",
							retryable: true,
						},
					}
				: {}),
		},
		async () => {
			reconnect();
			return { outcome: "pending" };
		},
	);
	const entry: PaneActionEntry = {
		paneId,
		status: failure ? "error" : !session ? "connecting" : "attached",
		error:
			failure instanceof Error
				? failure.message
				: failure
					? String(failure)
					: undefined,
		context: JSON.stringify({
			kind: "browser",
			resource: session?.resource,
			page: view.page,
			controller: expected,
			viewport: view.frame?.capture.viewport,
		}),
		actions: { "take-control": takeControl, reconnect: reconnectAction },
	};
	return { entry, takeControl };
}
