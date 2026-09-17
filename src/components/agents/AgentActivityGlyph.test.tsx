// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AgentActivityGlyph } from "./AgentActivityGlyph";

const slotOf = (container: HTMLElement) =>
	container.firstElementChild as HTMLElement;

describe("AgentActivityGlyph", () => {
	afterEach(cleanup);

	it("shows the loader in place of the logo while working, and no badge", () => {
		const { container } = render(
			<AgentActivityGlyph provider="claude" activity="working" />,
		);
		const slot = slotOf(container);
		expect(slot.querySelector(".dure-loader")).toBeTruthy();
		expect(slot.querySelector("svg")).toBeNull();
		expect(slot.querySelector('[role="img"]')).toBeNull();
	});

	it("shows the provider logo with the state as a corner badge otherwise", () => {
		const { container } = render(
			<AgentActivityGlyph provider="claude" activity="blocked" unread />,
		);
		const slot = slotOf(container);
		expect(slot.querySelector("svg")).toBeTruthy();
		expect(slot.querySelector(".dure-loader")).toBeNull();
		const badge = slot.querySelector('[role="img"]') as HTMLElement;
		expect(badge.className).toContain("bg-status-blocked");
		expect(badge.className).toContain("ring-ring/50");
		expect(badge.className).toContain("absolute");
	});

	it("draws no badge for the waiting state", () => {
		const { container } = render(
			<AgentActivityGlyph provider="claude" activity="waiting" unread />,
		);
		const slot = slotOf(container);
		expect(slot.querySelector("svg")).toBeTruthy();
		expect(slot.querySelector('[role="img"]')).toBeNull();
	});

	it("keeps the exited hollow dot so a dead session is not read as idle", () => {
		const { container } = render(
			<AgentActivityGlyph provider="codex" activity="exited" />,
		);
		const badge = slotOf(container).querySelector(
			'[role="img"]',
		) as HTMLElement;
		expect(badge.className).toContain("bg-transparent");
	});

	it("draws a terminal glyph without a provider and no badge when idle", () => {
		const { container } = render(<AgentActivityGlyph />);
		const slot = slotOf(container);
		// The terminal mark (ProviderLogo TerminalGlyph) carries a terminal-glyph class.
		expect(slot.querySelector("svg")?.getAttribute("class")).toMatch(
			/terminal/,
		);
		expect(slot.querySelector('[role="img"]')).toBeNull();
		expect(slot.querySelector(".dure-loader")).toBeNull();
	});
});
