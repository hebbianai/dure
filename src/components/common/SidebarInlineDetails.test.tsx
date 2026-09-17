// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SidebarInlineDetails } from "@/components/common/SidebarInlineDetails";

afterEach(cleanup);

describe("SidebarInlineDetails", () => {
	it("keeps the shared sidebar disclosure surface while forwarding row details", () => {
		render(
			<SidebarInlineDetails
				aria-label="Session details"
				data-session-details=""
				className="pb-2"
			>
				<span>Exact worktree</span>
			</SidebarInlineDetails>,
		);

		const details = screen.getByLabelText("Session details");
		expect(details.dataset.slot).toBe("sidebar-inline-details");
		expect(details.hasAttribute("data-session-details")).toBe(true);
		expect(details.className).toContain("basis-full");
		expect(details.className).toContain("border-glass-hairline");
		expect(details.className).toContain("pb-2");
		expect(screen.getByText("Exact worktree")).toBeTruthy();
	});
});
