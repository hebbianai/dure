// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PaneRehostBoundary } from "./PaneRehostBoundary";
import { StructuredTerminalRecoveryStatus } from "@/components/terminal/structured/StructuredTerminalRecoveryStatus";
import {
	beginPaneActionProgress,
	paneActionSnapshot,
} from "@/lib/workspace/pane/paneActionRegistry";
import { t } from "@/lib/i18n";

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn() }));
afterEach(cleanup);

it("keeps the pane mounted, blocks stale input, and restores it after Rehost", () => {
	const view = render(
		<PaneRehostBoundary paneId="term:body">
			<textarea defaultValue="retained draft" />
		</PaneRehostBoundary>,
	);
	const input = view.getByRole("textbox");
	let finish!: () => void;
	act(() => {
		finish = beginPaneActionProgress("term:body", "rehost");
	});
	try {
		expect(screen.getByRole("status").textContent).toContain(
			t("workspace.rehost.progress"),
		);
		expect(input.closest("[inert]")).not.toBeNull();
		expect(view.queryByRole("textbox")).toBeNull();
		expect(view.container.querySelector("textarea")).toBe(input);
	} finally {
		act(finish);
	}
	// Both the draft and DOM identity survive; the terminal is never remounted.
	expect(view.getByRole("textbox")).toBe(input);
	expect((input as HTMLTextAreaElement).value).toBe("retained draft");
	expect(view.queryByRole("status")).toBeNull();
});

it("does not show another pane's Rehost progress", () => {
	const finish = beginPaneActionProgress("term:other", "rehost");
	try {
		const view = render(
			<PaneRehostBoundary paneId="term:unaffected">
				<button type="button">Continue</button>
			</PaneRehostBoundary>,
		);
		expect(view.queryByRole("status")).toBeNull();
		expect(view.getByRole("button").closest("[inert]")).toBeNull();
	} finally {
		finish();
	}
});

it("suppresses transient recovery and automatic Resume until the explicit action settles", async () => {
	const paneId = "term:automatic";
	const resume = vi.fn(async () => {});
	const finish = beginPaneActionProgress(paneId, "rehost");
	const view = render(
		<StructuredTerminalRecoveryStatus
			paneId={paneId}
			error="session_exited"
			attachRecovery={{
				ownerKey: "fixture-runtime",
				automatic: true,
				intent: "resume",
				context: "pane=term:automatic",
				resume,
			}}
		/>,
	);
	try {
		expect(view.queryByRole("button")).toBeNull();
		expect(resume).not.toHaveBeenCalled();
		expect(paneActionSnapshot(paneId)?.actions).not.toContain("resume");
	} finally {
		await act(async () => {
			finish();
		});
	}
	// A genuine failure still offers the normal recovery path after settlement.
	expect(resume).toHaveBeenCalledOnce();
	expect(view.queryByRole("status")).not.toBeNull();
});
