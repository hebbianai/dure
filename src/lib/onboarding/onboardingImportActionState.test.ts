import { describe, expect, it } from "vitest";
import {
	onboardingImportActionEnabled,
	onboardingImportActionState,
} from "@/lib/onboarding/onboardingImportActionState";
import type { OnboardingImportDraft } from "@/lib/onboarding/onboardingImportDraft";

function draft({
	name = "HebbianIDE",
	selectedPaneCount = 1,
	included = true,
}: {
	name?: string;
	selectedPaneCount?: number;
	included?: boolean;
} = {}): OnboardingImportDraft {
	return {
		discoveredCount: Math.max(1, selectedPaneCount),
		desktops: [
			{
				id: "desktop-1",
				sourceGroupIdentity: "repo:hebbian",
				name,
				included,
				panes: Array.from({ length: Math.max(1, selectedPaneCount) }, (_, index) => ({
					key: `codex:${index}`,
					conversationId: `conversation-${index}`,
					title: `Conversation ${index}`,
					mtime: 100 - index,
					provider: "codex" as const,
					cwd: "/repo",
					workspaceRoot: "/repo",
					groupIdentity: "repo:hebbian",
					defaultSelected: true,
					executionLocation: "local" as const,
					selected: index < selectedPaneCount,
				})),
			},
		],
	};
}

describe("onboardingImportActionState", () => {
	it("requires a selected pane before any other draft recovery", () => {
		const state = onboardingImportActionState({
			draft: draft({ selectedPaneCount: 0, name: "" }),
			journalLocked: true,
			applyState: "failed",
		});

		expect(state).toEqual({ kind: "blocked", reason: "no_selection" });
		expect(onboardingImportActionEnabled(state)).toBe(false);
	});

	it("identifies the numbered desktop whose selected panes have no name", () => {
		const state = onboardingImportActionState({
			draft: draft({ name: "  " }),
			journalLocked: false,
			applyState: "idle",
		});

		expect(state).toEqual({
			kind: "blocked",
			reason: "desktop_name_required",
			desktopNumber: 1,
		});
	});

	it("reports the exact desktop, selection count, and active pane limit", () => {
		const state = onboardingImportActionState({
			draft: draft({ selectedPaneCount: 9 }),
			journalLocked: false,
			applyState: "idle",
		});

		expect(state).toEqual({
			kind: "blocked",
			reason: "desktop_pane_limit",
			desktopName: "HebbianIDE",
			selectedPaneCount: 9,
			desktopPaneLimit: 8,
		});
	});

	it("uses the supplied recovery limit before offering a journal retry", () => {
		const state = onboardingImportActionState({
			draft: draft({ selectedPaneCount: 10 }),
			journalLocked: true,
			applyState: "failed",
			desktopPaneLimit: 10,
		});

		expect(state).toEqual({ kind: "retry" });
		expect(onboardingImportActionEnabled(state)).toBe(true);
	});

	it("gives an in-flight apply priority over its locked journal", () => {
		expect(
			onboardingImportActionState({
				draft: draft(),
				journalLocked: true,
				applyState: "applying",
			}),
		).toEqual({ kind: "applying" });
	});

	it("enables a valid new draft", () => {
		const state = onboardingImportActionState({
			draft: draft(),
			journalLocked: false,
			applyState: "idle",
		});

		expect(state).toEqual({ kind: "ready" });
		expect(onboardingImportActionEnabled(state)).toBe(true);
	});
});
