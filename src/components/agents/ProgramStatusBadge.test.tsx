// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { t } from "@/lib/i18n";
import type {
	HmuxAgentRuntimeState,
	HmuxProgramStatus,
} from "@/lib/ipc/hmuxContracts";
import { ProgramStatusBadge } from "./ProgramStatusBadge";

function runtime(
	programStatus: HmuxProgramStatus | undefined,
	lifecycle: HmuxAgentRuntimeState["lifecycle"] = "running",
): HmuxAgentRuntimeState {
	return {
		terminalEpoch: "terminal-1",
		revision: "4",
		observedThroughOutputSeq: "9",
		lifecycle,
		activity: "waiting",
		attention: "none",
		source: "process_lifecycle",
		...(programStatus ? { programStatus } : {}),
	};
}

function hoveredDescription(label: string): string | null | undefined {
	fireEvent.pointerMove(screen.getByRole("button", { name: label }), {
		pointerType: "mouse",
	});
	act(() => vi.advanceTimersByTime(100));
	return screen
		.getByRole("tooltip")
		.querySelector("[data-slot='tooltip-description']")?.textContent;
}

describe("ProgramStatusBadge", () => {
	afterEach(() => {
		cleanup();
		vi.useRealTimers();
	});

	it("labels each way a program can need its user", () => {
		const cases: [HmuxProgramStatus, string][] = [
			[
				{ state: "blocked", blocked_kind: "permission" },
				t("agents.programStatus.permission"),
			],
			[
				{ state: "blocked", blocked_kind: "question" },
				t("agents.programStatus.question"),
			],
			[{ state: "blocked", blocked_kind: "auth" }, t("agents.programStatus.auth")],
			[{ state: "blocked" }, t("agents.programStatus.blocked")],
			[{ state: "error" }, t("agents.programStatus.error")],
		];
		for (const [status, label] of cases) {
			const { unmount } = render(
				<ProgramStatusBadge runtime={runtime(status)} />,
			);
			expect(screen.getByRole("button", { name: label })).toBeTruthy();
			unmount();
		}
	});

	it("renders nothing for quiet states, no status or an agent that is not running", () => {
		for (const state of [
			runtime(undefined),
			runtime({ state: "working", message: "Running tests" }),
			runtime({ state: "idle" }),
			runtime({ state: "done", message: "Finished" }),
			runtime({ state: "blocked" }, "exited"),
			runtime({ state: "error" }, "starting"),
			undefined,
		]) {
			const { container, unmount } = render(
				<ProgramStatusBadge runtime={state} />,
			);
			expect(container.textContent).toBe("");
			unmount();
		}
	});

	it("always says which program wrote the words it shows", () => {
		vi.useFakeTimers();
		const label = t("agents.programStatus.permission");
		const cases: [HmuxProgramStatus, string][] = [
			[
				{
					state: "blocked",
					blocked_kind: "permission",
					app: "claude-code",
					message: "Allow Bash(cargo test)?",
				},
				t("agents.programStatus.messageFromApp", {
					app: "claude-code",
					message: "Allow Bash(cargo test)?",
				}),
			],
			[
				{
					state: "blocked",
					blocked_kind: "permission",
					message: "Allow Bash(cargo test)?",
				},
				t("agents.programStatus.messageFromProgram", {
					message: "Allow Bash(cargo test)?",
				}),
			],
			[
				{ state: "blocked", blocked_kind: "permission", app: "claude-code" },
				t("agents.programStatus.reportedBy", { app: "claude-code" }),
			],
			[
				{ state: "blocked", blocked_kind: "permission" },
				t("agents.programStatus.reportedByProgram"),
			],
		];
		for (const [status, description] of cases) {
			const { unmount } = render(
				<ProgramStatusBadge runtime={runtime(status)} />,
			);
			expect(hoveredDescription(label)).toBe(description);
			unmount();
		}
	});
});
