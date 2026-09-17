// @vitest-environment jsdom

import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useCallback, useLayoutEffect, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTerminalCanvasFontReadiness } from "./useTerminalCanvasFontReadiness";

afterEach(() => cleanup());

describe("useTerminalCanvasFontReadiness", () => {
	it("observes readiness even when the passive effect sees loaded status", async () => {
		const previous = Object.getOwnPropertyDescriptor(document, "fonts");
		const events = new EventTarget();
		let status: FontFaceSetLoadStatus = "loading";
		let resolveReady!: (fontSet: FontFaceSet) => void;
		const ready = new Promise<FontFaceSet>((resolve) => {
			resolveReady = resolve;
		});
		const fontSet = events as unknown as FontFaceSet;
		Object.defineProperties(fontSet, {
			ready: { value: ready },
			status: { get: () => status },
		});
		Object.defineProperty(document, "fonts", {
			configurable: true,
			value: fontSet,
		});
		const refreshSurface = vi.fn();

		function RaceHarness() {
			const [, setRevision] = useState(0);
			const refresh = useCallback(() => {
				refreshSurface();
				setRevision((revision) => revision + 1);
			}, []);
			useTerminalCanvasFontReadiness(refresh);
			useLayoutEffect(() => {
				status = "loaded";
				resolveReady(fontSet);
			}, []);
			return null;
		}

		try {
			render(<RaceHarness />);
			await waitFor(() => expect(refreshSurface).toHaveBeenCalledOnce());
			await act(async () => {
				fontSet.dispatchEvent(new Event("loadingdone"));
				await Promise.resolve();
			});
			expect(refreshSurface).toHaveBeenCalledOnce();
		} finally {
			if (previous) {
				Object.defineProperty(document, "fonts", previous);
			} else {
				Reflect.deleteProperty(document, "fonts");
			}
		}
	});
});
