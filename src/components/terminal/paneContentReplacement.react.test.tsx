// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import {
	DockviewReact,
	type DockviewApi,
	type IDockviewPanelProps,
} from "dockview-react";
import { afterEach, expect, it, vi } from "vitest";
import { TerminalView } from "@/components/terminal/TerminalView";
import type { TerminalViewProps } from "@/components/terminal/TerminalViewProps";
import { StructuredTerminalRecoveryStatus } from "@/components/terminal/structured/StructuredTerminalRecoveryStatus";
import {
	hmuxStandaloneBinding,
	type HmuxPaneBindingV1,
} from "@/lib/terminal/terminalBinding";
import { paneActionSnapshot } from "@/lib/workspace/pane/paneActionRegistry";
import { addPanePreservingSizes } from "@/lib/workspace/pane/paneMutationSizing";

// Keep the real portal, visibility routing and status producer. Native transport
// is outside this fixture; App QA must separately prove the actual attachment.
vi.mock("@/components/terminal/structured/StructuredTerminalView", () => ({
	StructuredTerminalView: ({ paneApi, binding }: TerminalViewProps) => (
		<div data-session-id={binding?.sessionId}>
			<StructuredTerminalRecoveryStatus paneId={paneApi?.id} />
		</div>
	),
}));

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

const components = {
	launcher: () => <div data-content="launcher" />,
	terminal: ({
		api,
		params,
	}: IDockviewPanelProps<{ binding: HmuxPaneBindingV1 }>) => (
		<TerminalView
			paneApi={api}
			sessionId={params.binding.sessionId}
			kind="pty"
			binding={params.binding}
		/>
	),
};

for (const paneId of ["pane-react-stable", "launcher:historical-react"]) {
	it.each(["visible", "hidden"] as const)(
		`preserves the React content recipient in ${paneId} with document %s`,
		async (visibilityState) => {
			const visibility = vi
				.spyOn(document, "visibilityState", "get")
				.mockReturnValue(visibilityState);
			let api!: DockviewApi;
			const mounted = render(
				<DockviewReact
					components={components}
					onReady={(event) => {
						api = event.api;
					}}
				/>,
			);
			let previous!: ReturnType<DockviewApi["addPanel"]>;
			act(() => {
				api.layout(1000, 700);
				previous = api.addPanel({ id: paneId, component: "launcher" });
			});
			expect(
				mounted.container.querySelector('[data-content="launcher"]'),
			).not.toBeNull();
			const binding = hmuxStandaloneBinding("exact-runtime", "owned-workspace");
			let current!: typeof previous;
			act(() => {
				current = addPanePreservingSizes(api, {
					id: "ignored-replacement-id",
					component: "terminal",
					params: { binding },
					replacement: previous.api,
				});
			});
			expect(current.id).toBe(paneId);
			expect(current).not.toBe(previous);
			expect(current.api.component).toBe("terminal");
			expect(current.group).toBe(previous.group);
			expect(
				mounted.container.querySelector('[data-content="launcher"]'),
			).toBeNull();
			if (visibilityState === "hidden") {
				expect(paneActionSnapshot(paneId)).toBeUndefined();
				expect(mounted.container.querySelector("[data-session-id]")).toBeNull();
				act(() => {
					visibility.mockReturnValue("visible");
					document.dispatchEvent(new Event("visibilitychange"));
				});
			}
			await waitFor(() =>
				expect(paneActionSnapshot(paneId)?.status).toBe("attached"),
			);
			expect(
				mounted.container
					.querySelector("[data-session-id]")
					?.getAttribute("data-session-id"),
			).toBe(binding.sessionId);
			act(() => {
				visibility.mockReturnValue("hidden");
				document.dispatchEvent(new Event("visibilitychange"));
			});
			expect(paneActionSnapshot(paneId)).toBeUndefined();
			expect(api.getPanel(paneId)).toBe(current);
			expect(current.params).toEqual({ binding });
			act(() => {
				visibility.mockReturnValue("visible");
				document.dispatchEvent(new Event("visibilitychange"));
			});
			await waitFor(() =>
				expect(paneActionSnapshot(paneId)?.status).toBe("attached"),
			);
			expect(api.getPanel(paneId)).toBe(current);
			expect(api.panels).toHaveLength(1);
			mounted.unmount();
			expect(paneActionSnapshot(paneId)).toBeUndefined();
		},
	);
}
