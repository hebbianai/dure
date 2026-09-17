import { expect, it } from "vitest";
import {
	resolveMountedWorkspaceWindow,
	type WorkspaceWindowCollector,
	type WorkspaceWindowObservation,
} from "./mountedWorkspaceWindow";

function sample(
	windowLabel: string,
	active = true,
): WorkspaceWindowObservation {
	return {
		desktopId: "destination",
		windowLabel,
		active,
		mount: {
			schemaVersion: 1,
			desktopId: "destination",
			dockviewId: `dock-${windowLabel}`,
			windowLabel,
			windowGeneration: `boot-${windowLabel}`,
		},
	};
}
function collector(
	observations: WorkspaceWindowObservation[],
	transform?: (value: unknown) => unknown,
): WorkspaceWindowCollector {
	let receive: ((value: unknown) => void) | undefined;
	return {
		currentWindowLabel: () => "main",
		listWindowLabels: async () =>
			observations.map((observation) => observation.windowLabel),
		readLocal: () =>
			observations.find(
				(observation) => observation.windowLabel === "main",
			) ?? { ...sample("main"), mount: null },
		listenResponse: async (callback) => {
			receive = callback;
			return () => {
				receive = undefined;
			};
		},
		emitRequest: async (label, request) => {
			const value = {
				requestId: request.requestId,
				sample: observations.find(
					(observation) => observation.windowLabel === label,
				),
			};
			receive?.(transform ? transform(value) : value);
		},
	};
}
it("selects the unique active mounted workspace from fresh observations", async () => {
	await expect(
		resolveMountedWorkspaceWindow(
			"destination",
			undefined,
			collector([sample("main", false), sample("win-100-2")]),
		),
	).resolves.toEqual(sample("win-100-2").mount);
});
it("requires explicit selection when two windows actively mount the destination", async () => {
	const values = [sample("main"), sample("win-100-2")];
	await expect(
		resolveMountedWorkspaceWindow("destination", undefined, collector(values)),
	).rejects.toMatchObject({ code: "pane_ambiguous" });
	await expect(
		resolveMountedWorkspaceWindow(
			"destination",
			"win-100-2",
			collector(values),
		),
	).resolves.toEqual(sample("win-100-2").mount);
});
it("does not use the local mount when the selected native window has no frontend mount", async () => {
	await expect(
		resolveMountedWorkspaceWindow(
			"destination",
			"win-100-2",
			collector([sample("main"), { ...sample("win-100-2"), mount: null }]),
		),
	).rejects.toMatchObject({ code: "pane_not_found" });
});
it("does not infer absence from an unanswered window", async () => {
	await expect(
		resolveMountedWorkspaceWindow(
			"destination",
			undefined,
			collector([sample("main"), sample("win-100-2")], () => null),
			5,
		),
	).rejects.toMatchObject({ code: "pane_not_found" });
});
it("rejects a reported mount belonging to a different workspace", async () => {
	await expect(
		resolveMountedWorkspaceWindow(
			"destination",
			undefined,
			collector([
				sample("main"),
				{
					...sample("win-100-2"),
					mount: { ...sample("win-100-2").mount!, desktopId: "other" },
				},
			]),
			5,
		),
	).rejects.toMatchObject({ code: "pane_not_found" });
});
