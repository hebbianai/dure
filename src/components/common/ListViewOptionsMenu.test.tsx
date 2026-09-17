// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ListTree } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ListViewOptionsMenu } from "@/components/common/ListViewOptionsMenu";

afterEach(cleanup);

describe("ListViewOptionsMenu", () => {
	it("renders a radio section and the one bulk command that changes the view", async () => {
		const onValueChange = vi.fn();
		const onCollapseAll = vi.fn();
		render(
			<ListViewOptionsMenu
				label="View options"
				sections={[
					{
						id: "grouping",
						label: "Grouping",
						icon: ListTree,
						value: "repository",
						options: [
							{ value: "repository", label: "Repository" },
							{ value: "provider", label: "Provider" },
						],
						onValueChange,
					},
				]}
				canExpandAll
				canCollapseAll
				expandAllLabel="Expand all"
				collapseAllLabel="Collapse all"
				onExpandAll={vi.fn()}
				onCollapseAll={onCollapseAll}
			/>,
		);
		fireEvent.pointerDown(
			screen.getByRole("button", { name: "View options" }),
			{
				button: 0,
				ctrlKey: false,
			},
		);
		fireEvent.pointerMove(screen.getByRole("menuitem", { name: "Grouping" }), {
			pointerType: "mouse",
		});
		fireEvent.click(
			await screen.findByRole("menuitemradio", { name: "Provider" }),
		);
		expect(onValueChange).toHaveBeenCalledWith("provider");

		fireEvent.pointerDown(
			screen.getByRole("button", { name: "View options" }),
			{
				button: 0,
				ctrlKey: false,
			},
		);
		expect(screen.queryByRole("menuitem", { name: "Expand all" })).toBeNull();
		fireEvent.click(screen.getByRole("menuitem", { name: "Collapse all" }));
		expect(onCollapseAll).toHaveBeenCalledOnce();
	});
});
