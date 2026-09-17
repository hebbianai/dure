// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Alert } from "./alert";

afterEach(cleanup);

describe("Alert", () => {
	it("announces via role=alert with the comp's card, glyph and destructive copy", () => {
		render(<Alert role="alert">불러오지 못했습니다.</Alert>);
		const alert = screen.getByRole("alert");
		expect(alert.textContent).toContain("불러오지 못했습니다.");
		expect(alert.className).toContain("bg-card");
		expect(alert.className).toContain("border-border");
		expect(alert.className).toContain("rounded-lg");
		expect(alert.className).toContain("text-destructive");
		expect(alert.querySelector("svg")).toBeTruthy();
	});

	it("drops the glyph and keeps the caller's own block structure", () => {
		render(
			<Alert role="status" tone="warn" icon={false}>
				<p>제목</p>
				<p>설명</p>
			</Alert>,
		);
		const alert = screen.getByRole("status");
		expect(alert.querySelector("svg")).toBeNull();
		expect(alert.className).toContain("text-status-warn");
		expect(alert.querySelectorAll("p")).toHaveLength(2);
	});

	it("draws the sidebar's outline band without a card fill", () => {
		render(
			<Alert role="alert" surface="outline">
				실패
			</Alert>,
		);
		const alert = screen.getByRole("alert");
		expect(alert.className).not.toContain("bg-card");
		expect(alert.className).not.toContain("border-border");
		expect(alert.className).toContain("border-glass-hairline");
		expect(alert.className).toContain("text-meta");
	});

	it("docks to a pane on the pane's fill with the tone's own line", () => {
		render(
			<Alert role="alert" surface="dock">
				실패
			</Alert>,
		);
		const alert = screen.getByRole("alert");
		// The fill is the pane's, never a tone tint: a filled band is not a
		// form this system uses (owner call 2026-09-13).
		expect(alert.className).toContain("bg-glass-pane");
		expect(alert.className).not.toContain("bg-destructive");
		// The tone's line is what separates the band from the pane it covers.
		expect(alert.className).toContain("border-destructive/50");
		expect(alert.className).not.toContain("border-glass-hairline");
		expect(alert.className).toContain("text-meta");
	});

	it("keeps a neutral dock band on the hairline, not a tone line", () => {
		render(
			<Alert role="status" surface="dock" tone="neutral">
				복사했습니다
			</Alert>,
		);
		const alert = screen.getByRole("status");
		expect(alert.className).toContain("border-glass-hairline");
		expect(alert.className).not.toContain("border-destructive");
	});

	it("exposes an accessible dismiss action when requested", () => {
		const onDismiss = vi.fn();
		render(
			<Alert role="alert" dismiss={{ label: "닫기", onClick: onDismiss }}>
				실패
			</Alert>,
		);
		fireEvent.click(screen.getByRole("button", { name: "닫기" }));
		expect(onDismiss).toHaveBeenCalledOnce();
	});
});
