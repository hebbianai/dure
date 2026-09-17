// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
	beginTerminalDocumentResize,
	finishTerminalDocumentResize,
	registerTerminalDocumentResizeSurface,
	terminalDocumentResizeDiagnosticSnapshot,
	terminalDocumentResizePhase,
} from "./terminalDocumentResizeTransaction";

function isolatedDocument(): Document {
	return document.implementation.createHTMLDocument();
}

describe("terminal document resize transaction", () => {
	it("projects content-free authority and dirty-state diagnostics", () => {
		const doc = isolatedDocument();
		const registration = registerTerminalDocumentResizeSurface(doc, {
			surfaceKey: "surface-a",
			sessionKey: "secret-session-identity",
			canCommit: () => false,
			commit: vi.fn(),
		});
		beginTerminalDocumentResize(doc, "surface-a");
		registration.noteGeometryChanged();

		expect(terminalDocumentResizeDiagnosticSnapshot(doc)).toEqual({
			phase: "dragging",
			generation: 1,
			observationEpoch: 1,
			targetSurfaceKey: "surface-a",
			surfaces: [
				{
					surfaceKey: "surface-a",
					registrationCount: 1,
					latestRegistrationGeneration: 1,
					canCommit: false,
					dirtyRevision: 1,
					committedRevision: 0,
				},
			],
		});
		expect(
			JSON.stringify(terminalDocumentResizeDiagnosticSnapshot(doc)),
		).not.toContain("secret-session-identity");
		registration.dispose();
	});

	it("invalidates ordinary work captured before a drag", async () => {
		const doc = isolatedDocument();
		const commit = vi.fn();
		const registration = registerTerminalDocumentResizeSurface(doc, {
			surfaceKey: "surface-a",
			sessionKey: "session-a",
			canCommit: () => true,
			commit,
		});
		const stale = registration.captureObservation();

		beginTerminalDocumentResize(doc);
		expect(await registration.commitOrdinary(stale)).toBe(false);
		expect(commit).not.toHaveBeenCalled();
		registration.dispose();
	});

	it("reports when an ordinary geometry commit was not published", async () => {
		const doc = isolatedDocument();
		const registration = registerTerminalDocumentResizeSurface(doc, {
			surfaceKey: "surface-a",
			sessionKey: "session-a",
			canCommit: () => true,
			commit: () => false,
		});

		const observation = registration.captureObservation();
		expect(await registration.commitOrdinary(observation)).toBe(false);
		registration.dispose();
	});

	it("retains a failed settling commit until ordinary geometry convergence succeeds", async () => {
		const doc = isolatedDocument();
		let commitReady = false;
		const commit = vi.fn(() => commitReady);
		const registration = registerTerminalDocumentResizeSurface(doc, {
			surfaceKey: "surface-a",
			sessionKey: "session-a",
			canCommit: () => true,
			commit,
		});

		beginTerminalDocumentResize(doc);
		registration.noteGeometryChanged();
		finishTerminalDocumentResize(doc, "blur");

		await vi.waitFor(() =>
			expect(terminalDocumentResizePhase(doc)).toBe("idle"),
		);
		expect(commit).toHaveBeenCalledOnce();
		expect(terminalDocumentResizeDiagnosticSnapshot(doc).surfaces).toEqual([
			{
				surfaceKey: "surface-a",
				registrationCount: 1,
				latestRegistrationGeneration: 1,
				canCommit: true,
				dirtyRevision: 1,
				committedRevision: 0,
			},
		]);

		commitReady = true;
		const recovery = registration.noteGeometryChanged();
		expect(recovery).toBeDefined();
		expect(await registration.commitOrdinary(recovery!)).toBe(true);
		expect(terminalDocumentResizeDiagnosticSnapshot(doc).surfaces).toEqual([
			{
				surfaceKey: "surface-a",
				registrationCount: 1,
				latestRegistrationGeneration: 1,
				canCommit: true,
				dirtyRevision: 0,
				committedRevision: 0,
			},
		]);
		registration.dispose();
	});

	it("does not let an older ordinary commit clear a newer drag", async () => {
		const doc = isolatedDocument();
		let resolveCommit: ((committed: boolean) => void) | undefined;
		const registration = registerTerminalDocumentResizeSurface(doc, {
			surfaceKey: "surface-a",
			sessionKey: "session-a",
			canCommit: () => true,
			commit: () =>
				new Promise<boolean>((resolve) => {
					resolveCommit = resolve;
				}),
		});

		const pending = registration.commitOrdinary(
			registration.captureObservation(),
		);
		beginTerminalDocumentResize(doc);
		registration.noteGeometryChanged();
		resolveCommit?.(true);

		expect(await pending).toBe(false);
		expect(terminalDocumentResizeDiagnosticSnapshot(doc)).toMatchObject({
			phase: "dragging",
			surfaces: [{ dirtyRevision: 1, committedRevision: 0 }],
		});
		registration.dispose();
	});

	it("drains a newer observation that arrives while the first commit settles", async () => {
		const doc = isolatedDocument();
		const resolves: Array<() => void> = [];
		const commit = vi.fn(
			() =>
				new Promise<boolean>((resolve) => {
					resolves.push(() => resolve(true));
				}),
		);
		const registration = registerTerminalDocumentResizeSurface(doc, {
			surfaceKey: "surface-a",
			sessionKey: "session-a",
			canCommit: () => true,
			commit,
		});

		beginTerminalDocumentResize(doc);
		registration.noteGeometryChanged();
		finishTerminalDocumentResize(doc, "blur");
		expect(commit).toHaveBeenCalledOnce();
		registration.noteGeometryChanged();
		resolves[0]?.();
		await vi.waitFor(() => expect(commit).toHaveBeenCalledTimes(2));
		resolves[1]?.();
		await vi.waitFor(() =>
			expect(terminalDocumentResizePhase(doc)).toBe("idle"),
		);
		registration.dispose();
	});

	it("preserves dirty state across a rehosted successor view", async () => {
		const doc = isolatedDocument();
		const oldCommit = vi.fn();
		const successorCommit = vi.fn();
		const old = registerTerminalDocumentResizeSurface(doc, {
			surfaceKey: "pane-a",
			sessionKey: "session-a",
			canCommit: () => true,
			commit: oldCommit,
		});

		beginTerminalDocumentResize(doc);
		old.noteGeometryChanged();
		old.dispose();
		finishTerminalDocumentResize(doc, "blur");
		const successor = registerTerminalDocumentResizeSurface(doc, {
			surfaceKey: "pane-a",
			sessionKey: "session-b",
			canCommit: () => true,
			commit: successorCommit,
		});

		await vi.waitFor(() => expect(successorCommit).toHaveBeenCalledOnce());
		expect(oldCommit).not.toHaveBeenCalled();
		successor.dispose();
	});

	it("commits each current surface once and leaves Host session arbitration intact", async () => {
		const doc = isolatedDocument();
		const firstCommit = vi.fn();
		const secondCommit = vi.fn();
		const first = registerTerminalDocumentResizeSurface(doc, {
			surfaceKey: "window-a-pane",
			sessionKey: "shared-session",
			canCommit: () => true,
			commit: firstCommit,
		});
		const second = registerTerminalDocumentResizeSurface(doc, {
			surfaceKey: "window-b-pane",
			sessionKey: "shared-session",
			canCommit: () => true,
			commit: secondCommit,
		});

		beginTerminalDocumentResize(doc);
		first.noteGeometryChanged();
		second.noteGeometryChanged();
		finishTerminalDocumentResize(doc, "pointerup");

		await vi.waitFor(() => {
			expect(firstCommit).toHaveBeenCalledOnce();
			expect(secondCommit).toHaveBeenCalledOnce();
		});
		first.dispose();
		second.dispose();
	});

	it("does not let an older queued finish settle a newer drag", async () => {
		const doc = isolatedDocument();
		const commit = vi.fn();
		const registration = registerTerminalDocumentResizeSurface(doc, {
			surfaceKey: "surface-a",
			sessionKey: "session-a",
			canCommit: () => true,
			commit,
		});

		beginTerminalDocumentResize(doc);
		registration.noteGeometryChanged();
		finishTerminalDocumentResize(doc, "pointerup");
		beginTerminalDocumentResize(doc);
		registration.noteGeometryChanged();
		await Promise.resolve();
		expect(commit).not.toHaveBeenCalled();
		finishTerminalDocumentResize(doc, "pointerup");
		await vi.waitFor(() => expect(commit).toHaveBeenCalledOnce());
		registration.dispose();
	});
});
