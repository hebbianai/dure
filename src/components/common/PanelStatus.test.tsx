// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PanelStatus } from "@/components/common/PanelStatus";

afterEach(cleanup);

describe("PanelStatus", () => {
	it("renders children inside a full-height centered column", () => {
		render(<PanelStatus role="status">비어 있음</PanelStatus>);
		const block = screen.getByRole("status");
		expect(block.className).toContain("h-full");
		expect(block.className).toContain("items-center");
		expect(block.className).toContain("text-sm");
		expect(block.textContent).toBe("비어 있음");
	});

	it("switches the text tier via size and merges className", () => {
		render(
			<PanelStatus role="alert" size="xs" className="text-destructive">
				오류
			</PanelStatus>,
		);
		const block = screen.getByRole("alert");
		expect(block.className).toContain("text-xs");
		expect(block.className).not.toContain("text-sm");
		expect(block.className).toContain("text-destructive");
	});

	it("has no landmark role unless one is requested", () => {
		const { container } = render(<PanelStatus>내용</PanelStatus>);
		expect(container.firstElementChild?.getAttribute("role")).toBeNull();
	});
});
