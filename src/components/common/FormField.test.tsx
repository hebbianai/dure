// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FormField } from "@/components/common/FormField";

afterEach(cleanup);

describe("FormField", () => {
	it("auto-wires a generated id between the label and a single element child", () => {
		const { container } = render(
			<FormField label="표시 이름">
				<input />
			</FormField>,
		);
		const label = container.querySelector("label");
		const input = container.querySelector("input");
		expect(label?.getAttribute("for")).toBeTruthy();
		expect(input?.id).toBe(label?.getAttribute("for"));
	});

	it("respects an explicit htmlFor without cloning the child", () => {
		const { container } = render(
			<FormField label="대상" htmlFor="target-id">
				<select id="target-id" />
			</FormField>,
		);
		expect(container.querySelector("label")?.getAttribute("for")).toBe(
			"target-id",
		);
		expect(container.querySelector("select")?.id).toBe("target-id");
	});

	it("points the label at a child's existing id instead of overwriting it", () => {
		const { container } = render(
			<FormField label="이름">
				<input id="kept-id" />
			</FormField>,
		);
		expect(container.querySelector("label")?.getAttribute("for")).toBe(
			"kept-id",
		);
		expect(container.querySelector("input")?.id).toBe("kept-id");
	});

	it("leaves the label unassociated for multiple children without htmlFor", () => {
		const { container } = render(
			<FormField label="범위">
				<input />
				<input />
			</FormField>,
		);
		expect(container.querySelector("label")?.getAttribute("for")).toBeNull();
	});

	it("renders description and error paragraphs in the shared voice", () => {
		render(
			<FormField
				label="작업 이름"
				htmlFor="task"
				description="비워서 저장하면 자동 이름으로 돌아갑니다."
				error="이름이 너무 깁니다."
			>
				<input id="task" />
			</FormField>,
		);
		const description = screen.getByText(
			"비워서 저장하면 자동 이름으로 돌아갑니다.",
		);
		expect(description.className).toContain("text-muted-foreground");
		expect(description.className).toContain("text-[11px]");
		const error = screen.getByText("이름이 너무 깁니다.");
		expect(error.className).toContain("text-destructive");
	});

	it("uses the grid gap-2 row skeleton and merges className", () => {
		const { container } = render(
			<FormField label="이름" htmlFor="n" className="py-1">
				<input id="n" />
			</FormField>,
		);
		const row = container.firstElementChild;
		expect(row?.className).toContain("grid");
		// 8px from label to control (Figma 17375:198691, spacing/2).
		expect(row?.className).toContain("gap-2");
		expect(row?.className).toContain("py-1");
	});
});
