// @vitest-environment jsdom

import { act, render, screen } from "@testing-library/react";
import { memo } from "react";
import { describe, expect, it } from "vitest";
import { TerminalPresentationRoleStore } from "@/lib/terminal/presentation/terminalPresentationRoleStore";
import {
	useWorkspaceRuntimeActive,
	useWorkspaceTerminalPresentationRetained,
	useWorkspaceTerminalPresentationRole,
	WorkspaceRuntimeProvider,
} from "./WorkspaceRuntimeContext";

describe("WorkspaceRuntimeContext terminal presentation role", () => {
	it("rerenders only the old and new foreground panes on selection change", () => {
		const roleStore = new TerminalPresentationRoleStore();
		roleStore.configure({ active: true, foregroundPanelId: "term:one" });
		const renders = new Map<string, number>();
		const Probe = ({ panelId }: { panelId: string }) => {
			const role = useWorkspaceTerminalPresentationRole(panelId);
			renders.set(panelId, (renders.get(panelId) ?? 0) + 1);
			return <span data-testid={panelId}>{role}</span>;
		};

		render(
			<WorkspaceRuntimeProvider
				desktopId="desktop-1"
				active
				presentationRoleStore={roleStore}
				commitLayout={() => true}
			>
				<Probe panelId="term:one" />
				<Probe panelId="term:two" />
				<Probe panelId="term:three" />
			</WorkspaceRuntimeProvider>,
		);

		expect(screen.getByTestId("term:one").textContent).toBe("foreground");
		expect(screen.getByTestId("term:three").textContent).toBe("background");
		const before = new Map(renders);

		act(() => {
			roleStore.configure({ active: true, foregroundPanelId: "term:two" });
		});

		expect(screen.getByTestId("term:one").textContent).toBe("background");
		expect(screen.getByTestId("term:two").textContent).toBe("foreground");
		expect(renders.get("term:one")).toBe((before.get("term:one") ?? 0) + 1);
		expect(renders.get("term:two")).toBe((before.get("term:two") ?? 0) + 1);
		expect(renders.get("term:three")).toBe(before.get("term:three"));
	});

	it("does not rerender every background terminal when a retained workspace activates", () => {
		const roleStore = new TerminalPresentationRoleStore();
		roleStore.configure({ active: false, foregroundPanelId: "term:one" });
		const renders = new Map<string, number>();
		const Probe = memo(({ panelId }: { panelId: string }) => {
			const role = useWorkspaceTerminalPresentationRole(panelId);
			renders.set(panelId, (renders.get(panelId) ?? 0) + 1);
			return <span data-testid={`activation:${panelId}`}>{role}</span>;
		});
		const commitLayout = () => true;
		const view = (active: boolean) => (
			<WorkspaceRuntimeProvider
				desktopId="desktop-1"
				active={active}
				presentationRoleStore={roleStore}
				commitLayout={commitLayout}
			>
				<Probe panelId="term:one" />
				<Probe panelId="term:two" />
				<Probe panelId="term:three" />
			</WorkspaceRuntimeProvider>
		);
		const result = render(view(false));

		expect(screen.getByTestId("activation:term:two").textContent).toBe(
			"background",
		);
		const before = new Map(renders);
		act(() => {
			roleStore.configure({ active: true, foregroundPanelId: "term:one" });
			result.rerender(view(true));
		});

		expect(screen.getByTestId("activation:term:one").textContent).toBe(
			"foreground",
		);
		expect(renders.get("term:one")).toBe((before.get("term:one") ?? 0) + 1);
		expect(renders.get("term:two")).toBe(before.get("term:two"));
		expect(renders.get("term:three")).toBe(before.get("term:three"));
	});

	it("retains terminal presentation for a hidden warm desktop but not a frozen one", () => {
		const roleStore = new TerminalPresentationRoleStore();
		const Probe = () => {
			const active = useWorkspaceRuntimeActive();
			const retained = useWorkspaceTerminalPresentationRetained();
			return (
				<span data-testid="tier">
					{`${active ? "active" : "hidden"}:${retained ? "retained" : "released"}`}
				</span>
			);
		};
		const view = (active: boolean, frozen: boolean) => (
			<WorkspaceRuntimeProvider
				desktopId="desktop-1"
				active={active}
				frozen={frozen}
				presentationRoleStore={roleStore}
				commitLayout={() => true}
			>
				<Probe />
			</WorkspaceRuntimeProvider>
		);
		const result = render(view(true, false));
		expect(screen.getByTestId("tier").textContent).toBe("active:retained");

		result.rerender(view(false, false));
		expect(screen.getByTestId("tier").textContent).toBe("hidden:retained");

		result.rerender(view(false, true));
		expect(screen.getByTestId("tier").textContent).toBe("hidden:released");

		// Active always wins over a late tier reconciliation.
		result.rerender(view(true, true));
		expect(screen.getByTestId("tier").textContent).toBe("active:retained");
	});
});
