// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
	CandidateList,
	CleanupSummaryLine,
	DialogNotice,
	ReceiptSummary,
} from "@/components/common/CleanupDialog";

afterEach(cleanup);

describe("CleanupDialog kit", () => {
	it("DialogNotice renders a muted bordered notice and merges caller classes", () => {
		render(
			<DialogNotice className="mt-1">
				워크트리는 삭제하지 않습니다.
			</DialogNotice>,
		);
		const notice = screen.getByText("워크트리는 삭제하지 않습니다.");
		expect(notice.tagName).toBe("P");
		expect(notice.className).toContain("bg-muted/30");
		expect(notice.className).toContain("border-border/60");
		expect(notice.className).toContain("mt-1");
	});


	it("CandidateList renders caller-owned rows inside the bordered scroll list", () => {
		render(
			<CandidateList
				items={["a", "b"]}
				renderItem={(name) => <li key={name}>{name}</li>}
			/>,
		);
		const list = screen.getByRole("list");
		expect(list.className).toContain("max-h-44");
		expect(list.className).toContain("border-border/60");
		expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual(
			["a", "b"],
		);
	});

	it("CandidateList lets callers override height and density", () => {
		render(
			<CandidateList
				items={["a"]}
				maxHeightClass="max-h-36"
				className="space-y-0.5 p-1.5"
				renderItem={(name) => <li key={name}>{name}</li>}
			/>,
		);
		const list = screen.getByRole("list");
		expect(list.className).toContain("max-h-36");
		expect(list.className).not.toContain("max-h-44");
		// tailwind-merge: the caller's density replaces the defaults.
		expect(list.className).toContain("p-1.5");
		expect(list.className).not.toContain("p-2");
		expect(list.className).toContain("space-y-0.5");
		expect(list.className).not.toContain("space-y-1");
	});

	it("CandidateList shows emptyText (or nothing) when there are no candidates", () => {
		const { rerender, container } = render(
			<CandidateList
				items={[]}
				emptyText="후보 없음"
				renderItem={() => null}
			/>,
		);
		expect(screen.getByText("후보 없음").className).toContain(
			"text-muted-foreground",
		);
		expect(screen.queryByRole("list")).toBeNull();
		rerender(<CandidateList items={[]} renderItem={() => null} />);
		expect(container.textContent).toBe("");
	});

	it("ReceiptSummary renders the caller-formatted cleaned line and pre-mapped skip rows", () => {
		render(
			<ReceiptSummary
				cleanedCount={2}
				cleanedLabel={(n) => `${n}개 정리됨`}
				skippedHeading="2개는 건너뛰었습니다"
				skipped={[
					{ key: "a", name: "agent-a", reasonLabel: "이미 정리됨" },
					{ key: "b", name: "agent-b", reasonLabel: "오류", message: "boom" },
				]}
			/>,
		);
		expect(screen.getByText("2개 정리됨")).toBeTruthy();
		expect(screen.getByText("2개는 건너뛰었습니다")).toBeTruthy();
		expect(screen.getByText("agent-a — 이미 정리됨")).toBeTruthy();
		expect(screen.getByText("agent-b — 오류 (boom)")).toBeTruthy();
	});

	it("ReceiptSummary hides skipped heading/list without rows and keeps children", () => {
		render(
			<ReceiptSummary
				cleanedCount={3}
				cleanedLabel={(n) => `${n} cleaned`}
				skippedHeading="건너뜀"
				skipped={[]}
			>
				<p>실패 섹션</p>
			</ReceiptSummary>,
		);
		expect(screen.getByText("3 cleaned")).toBeTruthy();
		expect(screen.queryByRole("list")).toBeNull();
		expect(screen.queryByText("건너뜀")).toBeNull();
		expect(screen.getByText("실패 섹션")).toBeTruthy();
	});

	it("CleanupSummaryLine owns the shared cleanable/protected counts copy", () => {
		render(<CleanupSummaryLine cleanable={2} protectedCount={1} />);
		expect(screen.getByText("정리 가능 2개 · 보호됨 1개")).toBeTruthy();
	});
});
