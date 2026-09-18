// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Toaster } from "@/components/Toaster";
import { telemetryState } from "@/lib/ipc/telemetry";
import { DEFAULT_UI_PREFS, useStore } from "@/store";

vi.mock("@/lib/ipc/telemetry", () => ({
	telemetryState: vi.fn(),
	telemetrySetChoice: vi.fn(),
}));

const stateMock = vi.mocked(telemetryState);

beforeEach(() => {
	stateMock.mockReset();
	stateMock.mockResolvedValue({ effective: "pending", choice: null });
	useStore.setState({ projects: [], uiPrefs: { ...DEFAULT_UI_PREFS } });
});

afterEach(() => {
	cleanup();
	useStore.setState({ projects: [], uiPrefs: { ...DEFAULT_UI_PREFS } });
});

describe("Toaster telemetry notice", () => {
	it("waits until the first-run guide is closed or a project exists", async () => {
		render(<Toaster brief={false} />);
		await vi.waitFor(() => expect(stateMock).toHaveBeenCalledTimes(1));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(screen.queryByRole("status")).toBeNull();

		useStore.setState({
			uiPrefs: { ...DEFAULT_UI_PREFS, onboardingDismissed: true },
		});
		expect(await screen.findByRole("status")).toBeTruthy();
		// One state load per window, whatever the guide did meanwhile.
		expect(stateMock).toHaveBeenCalledTimes(1);
	});

	it("also shows once a project exists, even with the guide never closed", async () => {
		useStore.setState({
			projects: [
				{ id: "p1", name: "p1", path: "/repo/p1", kind: "local", isRepo: true },
			],
		});
		render(<Toaster brief={false} />);
		expect(await screen.findByRole("status")).toBeTruthy();
	});
});
