// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RestoreAllAgentsNotice } from "@/components/common/RestoreAllAgentsNotice";
import { t } from "@/lib/i18n";
import { restoreAllManagedAgents } from "@/lib/sessions/managed/managedRestoreAll";
import {
	beginRestoreAll,
	finishRestoreAll,
	getRestoreAllState,
	publishRestoreAllOffer,
	reportRestoreAllProgress,
	resetRestoreAllForTest,
} from "@/lib/sessions/managed/managedRestoreAllOffer";

vi.mock("@/lib/sessions/managed/managedRestoreAll", () => ({
	restoreAllManagedAgents: vi.fn(),
}));

const entry = (id: string, name = id) => ({ identity: id, agentId: id, name });

beforeEach(resetRestoreAllForTest);
afterEach(() => {
	cleanup();
	vi.mocked(restoreAllManagedAgents).mockClear();
});

describe("RestoreAllAgentsNotice", () => {
	it("offers one action for the stopped agents and lists the ones it can't restore", () => {
		render(<RestoreAllAgentsNotice />);
		expect(screen.queryByRole("heading")).toBeNull();

		act(() =>
			publishRestoreAllOffer({
				restorable: [entry("a"), entry("b")],
				skipped: [{ ...entry("c", "Reviewer"), reason: "no_conversation_id" }],
			}),
		);
		expect(
			screen.getByRole("heading", {
				name: t("agents.restoreAll.offerTitleMany", { count: 2 }),
			}),
		).toBeTruthy();
		expect(screen.getByText("Reviewer")).toBeTruthy();
		expect(
			screen.getByText(t("agents.restoreAll.reason.noConversation"), {
				exact: false,
			}),
		).toBeTruthy();

		fireEvent.click(
			screen.getByRole("button", { name: t("agents.restoreAll.restore") }),
		);
		expect(restoreAllManagedAgents).toHaveBeenCalledOnce();
	});

	it("goes away on Not now and while hidden", () => {
		publishRestoreAllOffer({ restorable: [entry("a")], skipped: [] });
		const { rerender } = render(<RestoreAllAgentsNotice hidden />);
		expect(screen.queryByRole("heading")).toBeNull();

		rerender(<RestoreAllAgentsNotice />);
		expect(
			screen.getByRole("heading", {
				name: t("agents.restoreAll.offerTitleOne"),
			}),
		).toBeTruthy();
		fireEvent.click(
			screen.getByRole("button", { name: t("agents.restoreAll.notNow") }),
		);
		expect(screen.queryByRole("heading")).toBeNull();
		expect(getRestoreAllState()).toEqual({ phase: "idle" });
	});

	it("shows progress, then what was restored and why the rest were not", () => {
		publishRestoreAllOffer({
			restorable: [entry("a"), entry("b"), entry("d")],
			skipped: [],
		});
		render(<RestoreAllAgentsNotice />);
		act(() => {
			beginRestoreAll();
			reportRestoreAllProgress(1, 3);
		});
		expect(screen.getByRole("status").textContent).toBe(
			t("agents.restoreAll.progress", { done: 1, total: 3 }),
		);

		act(() =>
			finishRestoreAll({
				restored: [entry("a")],
				skipped: [{ ...entry("b", "Builder"), reason: "worktree_missing" }],
				failed: [entry("d", "Docs")],
			}),
		);
		expect(
			screen.getByRole("heading", {
				name: t("agents.restoreAll.restoredOne"),
			}),
		).toBeTruthy();
		expect(screen.getByRole("status").textContent).toBe(
			t("agents.restoreAll.notRestoredMany", { count: 2 }),
		);
		const rows = screen.getAllByRole("listitem").map((row) => row.textContent);
		expect(rows).toEqual([
			`Docs — ${t("agents.restoreAll.reason.failed")}`,
			`Builder — ${t("agents.restoreAll.reason.worktreeMissing", {
				action: t("terminal.recovery.recreateWorktree"),
			})}`,
		]);

		fireEvent.click(screen.getByRole("button", { name: t("common.close") }));
		expect(getRestoreAllState()).toEqual({ phase: "idle" });
	});

	it("summarizes a long list with a count", () => {
		publishRestoreAllOffer({
			restorable: [entry("a")],
			skipped: ["b", "c", "d", "e", "f", "g"].map((id) => ({
				...entry(id),
				reason: "pane_missing" as const,
			})),
		});
		render(<RestoreAllAgentsNotice />);
		const rows = screen.getAllByRole("listitem");
		expect(rows).toHaveLength(5);
		expect(rows[4].textContent).toBe(t("agents.restoreAll.more", { count: 2 }));
	});
});
