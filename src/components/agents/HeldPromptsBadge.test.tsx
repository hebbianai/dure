// @vitest-environment jsdom

import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { t } from "@/lib/i18n";
import type {
	HmuxAgentRuntimeState,
	HmuxHeldPrompts,
} from "@/lib/ipc/hmuxContracts";
import { HeldPromptsBadge } from "./HeldPromptsBadge";

const NOW = Date.UTC(2026, 10, 25, 9, 0);

function runtime(
	heldPrompts: HmuxHeldPrompts | undefined,
	lifecycle: HmuxAgentRuntimeState["lifecycle"] = "running",
): HmuxAgentRuntimeState {
	return {
		terminalEpoch: "terminal-1",
		revision: "4",
		observedThroughOutputSeq: "9",
		lifecycle,
		activity: "waiting",
		attention: "none",
		source: "provider_event",
		...(heldPrompts ? { heldPrompts } : {}),
	};
}

describe("HeldPromptsBadge", () => {
	afterEach(() => {
		cleanup();
		vi.useRealTimers();
	});

	it("names how many messages unsent input holds and since when", () => {
		vi.useFakeTimers({ now: NOW });
		render(
			<HeldPromptsBadge
				runtime={runtime({ count: 3, sinceUnixMs: NOW - 12 * 60_000 })}
			/>,
		);
		const label = t("agents.heldPrompts.status.other", { n: 3 });
		fireEvent.pointerMove(screen.getByRole("button", { name: label }), {
			pointerType: "mouse",
		});
		act(() => vi.advanceTimersByTime(100));
		expect(
			screen
				.getByRole("tooltip")
				.querySelector("[data-slot='tooltip-description']")?.textContent,
		).toBe(
			t("agents.heldPrompts.description", {
				age: t("common.time.minutesAgo", { n: 12 }),
			}),
		);
	});

	it("uses the singular label for one message", () => {
		render(
			<HeldPromptsBadge runtime={runtime({ count: 1, sinceUnixMs: NOW })} />,
		);
		expect(
			screen.getByRole("button", { name: t("agents.heldPrompts.status.one") }),
		).toBeTruthy();
	});

	it("shows nothing when no message is held or the agent is not running", () => {
		const { container, rerender } = render(
			<HeldPromptsBadge runtime={runtime(undefined)} />,
		);
		expect(container.textContent).toBe("");
		rerender(
			<HeldPromptsBadge
				runtime={runtime({ count: 2, sinceUnixMs: NOW }, "exited")}
			/>,
		);
		expect(container.textContent).toBe("");
		rerender(<HeldPromptsBadge runtime={undefined} />);
		expect(container.textContent).toBe("");
	});
});
