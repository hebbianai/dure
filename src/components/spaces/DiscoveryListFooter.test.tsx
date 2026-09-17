// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscoveryListFooter } from "@/components/spaces/DiscoveryListFooter";

afterEach(cleanup);

describe("DiscoveryListFooter", () => {
	it("renders nothing while every item is shown", () => {
		const { container } = render(
			<DiscoveryListFooter shown={3} total={3} onShowAll={vi.fn()} />,
		);
		expect(container.textContent).toBe("");
	});

	it("offers the show-all button while collapsed without a search", () => {
		const onShowAll = vi.fn();
		render(<DiscoveryListFooter shown={5} total={7} onShowAll={onShowAll} />);
		fireEvent.click(screen.getByRole("button", { name: "전체 보기 (7)" }));
		expect(onShowAll).toHaveBeenCalledTimes(1);
	});

	it("degrades to the truncation hint once expanded or while searching", () => {
		const { rerender } = render(
			<DiscoveryListFooter
				shown={120}
				total={150}
				showAll
				onShowAll={vi.fn()}
			/>,
		);
		expect(screen.queryByRole("button")).toBeNull();
		expect(
			screen.getByText("상위 120개 표시 · 검색으로 좁히세요 (총 150)"),
		).toBeTruthy();

		rerender(
			<DiscoveryListFooter
				shown={120}
				total={150}
				searchActive
				onShowAll={vi.fn()}
			/>,
		);
		expect(screen.queryByRole("button")).toBeNull();
		expect(
			screen.getByText("상위 120개 표시 · 검색으로 좁히세요 (총 150)"),
		).toBeTruthy();
	});

	it("always hints when the caller has no show-all mechanism", () => {
		render(<DiscoveryListFooter shown={120} total={130} />);
		expect(
			screen.getByText("상위 120개 표시 · 검색으로 좁히세요 (총 130)"),
		).toBeTruthy();
	});

	it("passes className through to whichever element renders", () => {
		render(
			<DiscoveryListFooter
				shown={5}
				total={7}
				onShowAll={vi.fn()}
				className="mt-1"
			/>,
		);
		expect(
			screen.getByRole("button", { name: "전체 보기 (7)" }).className,
		).toContain("mt-1");
	});
});
