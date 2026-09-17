// @vitest-environment jsdom

import { create } from "@bufbuild/protobuf";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ViewportFrameSchema } from "@/contracts/terminalStateProtocol";
import type { TerminalDocumentResizeSurfaceRegistration } from "@/lib/terminal/geometry/terminalDocumentResizeTransaction";
import type { InstalledTerminalViewportFrame } from "@/lib/terminal/state/structuredTerminalViewport";
import { useStructuredTerminalLargeViewLifecycle } from "./useStructuredTerminalLargeViewLifecycle";

vi.mock("@/components/workspace/WorkspaceRuntimeContext", () => ({
	useWorkspaceRuntimeDesktopId: () => undefined,
}));

vi.mock("@/lib/workspace/window/currentWindowFocus", () => ({
	currentWindowIsFocused: () => true,
	subscribeCurrentWindowFocus: () => () => {},
}));

vi.mock("@/lib/workspace/window/largeViewReturnSourceRuntime", () => ({
	bindLargeViewReturnSource: vi.fn(),
}));

function installedFrame(): InstalledTerminalViewportFrame {
	return {
		schemaMinor: 4,
		frame: create(ViewportFrameSchema, {
			projectionRevision: 1n,
			canonicalColumns: 80,
			viewportRows: 20,
		}),
	};
}

describe("structured terminal attached geometry", () => {
	it("keeps unpublished geometry pending until a later frame can publish it", async () => {
		const attachedGeometryPendingRef = { current: "attachment-a" };
		const commitOrdinary = vi
			.fn<TerminalDocumentResizeSurfaceRegistration["commitOrdinary"]>()
			.mockResolvedValueOnce(false)
			.mockResolvedValueOnce(true);
		const registration: TerminalDocumentResizeSurfaceRegistration = {
			generation: 1,
			surfaceKey: "pane-a",
			captureObservation: () => ({
				observationEpoch: 1,
				registrationGeneration: 1,
				surfaceKey: "pane-a",
			}),
			noteGeometryChanged: () => ({
				observationEpoch: 1,
				registrationGeneration: 1,
				surfaceKey: "pane-a",
			}),
			commitOrdinary,
			dispose: () => {},
		};
		const options = {
			workspaceId: undefined,
			sessionId: "session-a",
			surfaceId: "pane-a",
			containerRef: { current: null },
			geometryRef: { current: { columns: 80, rows: 20 } },
			attachedObserverRef: { current: "attachment-a" },
			attachedGeometryPendingRef,
			resizeRegistrationRef: { current: registration },
			attachmentId: "attachment-a",
			terminalEpoch: "epoch-a",
			stateRevision: 1n,
			onGeometryObserved: vi.fn(),
			requestReturnRetirementFence: () => undefined,
			holdPresentation: vi.fn(),
			releasePresentation: vi.fn(),
		};
		const { rerender } = renderHook(
			({ frame }) =>
				useStructuredTerminalLargeViewLifecycle({
					...options,
					installedFrame: frame,
				}),
			{ initialProps: { frame: installedFrame() } },
		);

		await waitFor(() => expect(commitOrdinary).toHaveBeenCalledOnce());
		expect(attachedGeometryPendingRef.current).toBe("attachment-a");

		await act(async () => rerender({ frame: installedFrame() }));
		await waitFor(() => expect(commitOrdinary).toHaveBeenCalledTimes(2));
		expect(attachedGeometryPendingRef.current).toBeUndefined();
	});
});
