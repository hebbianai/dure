// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useBackendCompatibilityStore } from "@/lib/platform/backendCompatibilityStore";
import { BackendSkewChip } from "./BackendSkewChip";

vi.mock("@/lib/i18n", () => ({
	t: (message: string) => message,
}));

afterEach(() => {
	cleanup();
	useBackendCompatibilityStore.setState({ compatibility: null });
});

describe("BackendSkewChip", () => {
	it("explains the bounded Windows preview instead of suggesting a restart", () => {
		useBackendCompatibilityStore.setState({
			compatibility: {
				mode: "degraded",
				comparisonBasis: "none",
				frontendBuildId: "0.1.4+frontend",
				frontendSourceRevision: null,
				frontendWorktreeOverlay: "unknown",
				frontendRuntimeFingerprint: null,
				backend: {
					name: "dure-backend-windows-preview",
					packageVersion: "0.1.4",
					protocolVersion: 1,
					buildId: "0.1.4+backend",
					runtimeFingerprint: null,
					features: ["windows.desktop-preview-v1"],
				},
				missingFeatures: ["hmux.managed-create-v1"],
			},
		});

		const chip = render(<BackendSkewChip />).getByText(
			"workspace.windowsPreview.label",
		);

		expect(chip.getAttribute("aria-label")).toBe("workspace.windowsPreview.detail");
		expect(screen.queryByText("workspace.backendSkew.incompatible")).toBeNull();
	});
});
