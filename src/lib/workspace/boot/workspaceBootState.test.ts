// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	markWorkspacePainted,
	WORKSPACE_PAINTED_EVENT,
	resetWorkspaceBootForTest,
	subscribeWorkspaceBoot,
	workspacePainted,
} from "@/lib/workspace/boot/workspaceBootState";

afterEach(() => {
	resetWorkspaceBootForTest();
});

describe("workspaceBootState", () => {
	it("starts unpainted and flips once, telling subscribers once", () => {
		const listener = vi.fn();
		const unsubscribe = subscribeWorkspaceBoot(listener);
		expect(workspacePainted()).toBe(false);
		markWorkspacePainted();
		markWorkspacePainted();
		expect(workspacePainted()).toBe(true);
		expect(listener).toHaveBeenCalledTimes(1);
		unsubscribe();
	});

	it("announces the paint on the document exactly once", () => {
		const heard = vi.fn();
		document.addEventListener(WORKSPACE_PAINTED_EVENT, heard);
		markWorkspacePainted();
		markWorkspacePainted();
		document.removeEventListener(WORKSPACE_PAINTED_EVENT, heard);
		expect(heard).toHaveBeenCalledTimes(1);
	});

	it("stops notifying after unsubscribe", () => {
		const listener = vi.fn();
		subscribeWorkspaceBoot(listener)();
		markWorkspacePainted();
		expect(listener).not.toHaveBeenCalled();
	});
});
