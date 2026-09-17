// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionsViewOptionsMenu } from "@/components/sessions/SessionsViewOptionsMenu";
import { setLang, t } from "@/lib/i18n";

afterEach(() => {
	cleanup();
	setLang("ko");
});

describe("SessionsViewOptionsMenu", () => {
	it("offers grouping, ordering, pane filtering, and the applicable bulk fold", async () => {
		setLang("en");
		const onChange = vi.fn();
		const onCollapseAll = vi.fn();
		render(
			<SessionsViewOptionsMenu
				value={{
					groupBy: "repository",
					orderBy: "updated",
					paneFilter: "all",
				}}
				onChange={onChange}
				canExpandAll={false}
				canCollapseAll
				onExpandAll={vi.fn()}
				onCollapseAll={onCollapseAll}
			/>,
		);
		fireEvent.pointerDown(
			screen.getByRole("button", { name: t("sessions.viewOptions.title") }),
			{ button: 0, ctrlKey: false },
		);
		expect(screen.getAllByRole("menuitem")).toHaveLength(4);
		fireEvent.pointerMove(
			screen.getByRole("menuitem", {
				name: t("sessions.viewOptions.filtering"),
			}),
			{ pointerType: "mouse" },
		);
		const allSessionsOption = await screen.findByRole("menuitemradio", {
			name: t("sessions.viewOptions.filterAll"),
		});
		const filterSubmenu = allSessionsOption.closest(
			'[data-slot="dropdown-menu-sub-content"]',
		);
		expect(filterSubmenu).not.toBeNull();
		for (const className of ["w-max", "min-w-64", "max-w-[calc(100vw-1rem)]"]) {
			expect(filterSubmenu?.classList.contains(className)).toBe(true);
		}
		fireEvent.click(
			await screen.findByRole("menuitemradio", {
				name: t("sessions.viewOptions.filterOpenOnly"),
			}),
		);
		expect(onChange).toHaveBeenCalledWith({
			groupBy: "repository",
			orderBy: "updated",
			paneFilter: "open_only",
		});

		fireEvent.pointerDown(
			screen.getByRole("button", { name: t("sessions.viewOptions.title") }),
			{ button: 0, ctrlKey: false },
		);
		fireEvent.click(
			screen.getByRole("menuitem", {
				name: t("sessions.viewOptions.collapseAll"),
			}),
		);
		expect(onCollapseAll).toHaveBeenCalledOnce();
	});
});
