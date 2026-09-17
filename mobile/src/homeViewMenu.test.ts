import { describe, expect, it, vi } from "vitest";
import {
	DEFAULT_SPACES_VIEW_OPTIONS,
	EMPTY_SPACES_FILTERS,
	type SpacesGrouping,
} from "@/lib/spaces/spacesViewOptions";
import { spacesFilterChoices } from "@/lib/spaces/spacesViewProjection";
import { placeMenuCard, renderHomeViewMenu } from "./homeViewMenu";
import { t } from "./i18n";

describe("view menu card placement", () => {
	const row = { rowTop: 500, rowHeight: 48, cardHeight: 220 };
	it("stands under its row when the panel's window has room", () => {
		expect(placeMenuCard({ ...row, viewTop: 0, viewHeight: 840 })).toEqual({
			top: 552,
			above: false,
		});
	});
	it("stands above its row when only that keeps it in view", () => {
		expect(placeMenuCard({ ...row, viewTop: 0, viewHeight: 650 })).toEqual({
			top: 276,
			above: true,
		});
	});
	it("judges the window the panel shows, not the height it scrolls", () => {
		// The panel has scrolled 300 down: the room above the row is off-screen.
		expect(placeMenuCard({ ...row, viewTop: 300, viewHeight: 650 })).toEqual({
			top: 552,
			above: false,
		});
	});
	it("caps the card to the roomier side when neither side holds it whole", () => {
		// 160 above the row, 394 below: under, at most 394 tall, scrolling inside.
		expect(
			placeMenuCard({ rowTop: 172, rowHeight: 48, cardHeight: 408, viewTop: 0, viewHeight: 626 }),
		).toEqual({ top: 224, above: false, maxHeight: 394 });
		// Mirrored: 488 above, 66 below — above, from the panel's 8px margin down.
		expect(
			placeMenuCard({ rowTop: 500, rowHeight: 48, cardHeight: 600, viewTop: 0, viewHeight: 626 }),
		).toEqual({ top: 8, above: true, maxHeight: 488 });
	});
});

describe("mobile Show settings", () => {
	it("toggles Space using the shared space visibility preference", () => {
		const change = vi.fn();
		const node = renderHomeViewMenu(
			DEFAULT_SPACES_VIEW_OPTIONS,
			"show",
			spacesFilterChoices([], DEFAULT_SPACES_VIEW_OPTIONS.filters),
			{ change, navigate: vi.fn() },
		);
		// The 표시 card is open, so its items are the only buttons under it.
		const button = [
			...node.querySelectorAll<HTMLButtonElement>('[data-facet="show"] button'),
		].find((node) => node.textContent?.trim() === "Space");
		expect(button).toBeDefined();
		button!.click();
		expect(change.mock.calls[0][0].showSpaces).toBe(false);
		expect(change.mock.calls[0][0].visibleFields).toEqual(
			DEFAULT_SPACES_VIEW_OPTIONS.visibleFields,
		);
	});

	it.each<{ groupBy: SpacesGrouping; hidden: string[] }>([
		{ groupBy: "space", hidden: ["common.space"] },
		{ groupBy: "environment", hidden: ["spaces.pane.environment"] },
		{
			groupBy: "location",
			hidden: ["spaces.pane.environment", "spaces.pane.machine"],
		},
	])(
		"omits Show controls already stated by $groupBy",
		({ groupBy, hidden }) => {
			const value = { ...DEFAULT_SPACES_VIEW_OPTIONS, groupBy };
			const node = renderHomeViewMenu(
				value,
				"show",
				spacesFilterChoices([], value.filters),
				{ change: vi.fn(), navigate: vi.fn() },
			);
			const offered = [
				...node.querySelectorAll('[data-facet="show"] [role="menuitemcheckbox"]'),
			].map((button) => button.textContent?.trim());
			for (const key of hidden) expect(offered).not.toContain(t(key));
			expect(offered).toContain(t("spaces.pane.branch"));
		},
	);
});

describe("the filters' reset", () => {
	const render = (value = DEFAULT_SPACES_VIEW_OPTIONS, change = vi.fn()) =>
		renderHomeViewMenu(value, "root", spacesFilterChoices([], value.filters), {
			change,
			navigate: vi.fn(),
		});

	it("is the sheet's last row, after the filters, not a control beside their heading", () => {
		const node = render();
		const buttons = [...node.querySelectorAll<HTMLButtonElement>(".home-menu__list button")];
		expect(buttons[buttons.length - 1]?.textContent).toBe(t("spaces.pane.resetFilters"));
		expect(buttons[buttons.length - 2]?.dataset.row).toBe("source");
		expect(node.querySelector(".home-menu__filters button")).toBeNull();
	});

	it("dims while there is nothing to reset, and empties the filters when pressed", () => {
		expect(render().querySelector<HTMLButtonElement>(".home-menu__reset")?.disabled).toBe(true);
		const change = vi.fn();
		const value = {
			...DEFAULT_SPACES_VIEW_OPTIONS,
			filters: { ...DEFAULT_SPACES_VIEW_OPTIONS.filters, status: ["unknown" as const] },
		};
		const reset = render(value, change).querySelector<HTMLButtonElement>(".home-menu__reset");
		expect(reset?.disabled).toBe(false);
		reset?.click();
		expect(change).toHaveBeenCalledWith({ ...value, filters: EMPTY_SPACES_FILTERS });
	});
});
