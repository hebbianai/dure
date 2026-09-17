// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
	EmptyHint,
	LoadingRow,
} from "@/components/common/StatusBlocks";

afterEach(cleanup);

describe("StatusBlocks", () => {
	it("LoadingRow announces via role=status and hides the spinner from a11y", () => {
		render(<LoadingRow className="px-3 py-3">불러오는 중…</LoadingRow>);
		const row = screen.getByRole("status");
		expect(row.textContent).toContain("불러오는 중…");
		expect(row.className).toContain("text-muted-foreground");
		expect(row.className).toContain("px-3");
		expect(row.querySelector('.dure-loader[aria-hidden="true"]')).toBeTruthy();
	});



	it("EmptyHint renders a centered paragraph and merges caller padding", () => {
		render(<EmptyHint className="py-8">결과 없음</EmptyHint>);
		const hint = screen.getByText("결과 없음");
		expect(hint.tagName).toBe("P");
		expect(hint.className).toContain("text-center");
		// tailwind-merge: the caller's py-8 replaces the default py-5.
		expect(hint.className).toContain("py-8");
		expect(hint.className).not.toContain("py-5");
	});
});
