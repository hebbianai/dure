// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpacesViewOptionsMenu } from "@/components/spaces/SpacesViewOptionsMenu";
import { t } from "@/lib/i18n";
import { DEFAULT_SPACES_VIEW_OPTIONS } from "@/lib/spaces/spacesViewOptions";

const NO_FILTER_CHOICES = {
	status: [],
	environment: [],
	repository: [],
	location: [],
	source: [],
} as const;

afterEach(cleanup);

describe("SpacesViewOptionsMenu", () => {
	it("shows only the bulk command that can change the view", async () => {
		const onCollapseAll = vi.fn();
		render(
			<SpacesViewOptionsMenu
				value={DEFAULT_SPACES_VIEW_OPTIONS}
				onChange={vi.fn()}
				filterChoices={NO_FILTER_CHOICES}
				canExpandAll
				canCollapseAll
				onExpandAll={vi.fn()}
				onCollapseAll={onCollapseAll}
			/>,
		);

		const trigger = screen.getByRole("button", {
			name: t("spaces.pane.viewOptions"),
		});
		fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });

		expect(
			screen.queryByRole("menuitem", { name: t("spaces.pane.expandAll") }),
		).toBeNull();
		fireEvent.click(
			screen.getByRole("menuitem", { name: t("spaces.pane.collapseAll") }),
		);
		expect(onCollapseAll).toHaveBeenCalledOnce();
	});

	it("disables Reset when view options already match their defaults", () => {
		render(
			<SpacesViewOptionsMenu
				value={DEFAULT_SPACES_VIEW_OPTIONS}
				onChange={vi.fn()}
				filterChoices={NO_FILTER_CHOICES}
				canExpandAll={false}
				canCollapseAll
				onExpandAll={vi.fn()}
				onCollapseAll={vi.fn()}
			/>,
		);
		fireEvent.pointerDown(
			screen.getByRole("button", { name: t("spaces.pane.viewOptions") }),
			{ button: 0, ctrlKey: false },
		);
		expect(
			screen
				.getByText(t("spaces.pane.reset"))
				.closest('[role="menuitem"]')
				?.getAttribute("data-disabled"),
		).not.toBeNull();
	});

	it("switches the single bulk command to expand when every group is collapsed", async () => {
		const onExpandAll = vi.fn();
		render(
			<SpacesViewOptionsMenu
				value={DEFAULT_SPACES_VIEW_OPTIONS}
				onChange={vi.fn()}
				filterChoices={NO_FILTER_CHOICES}
				canExpandAll
				canCollapseAll={false}
				onExpandAll={onExpandAll}
				onCollapseAll={vi.fn()}
			/>,
		);

		fireEvent.pointerDown(
			screen.getByRole("button", { name: t("spaces.pane.viewOptions") }),
			{ button: 0, ctrlKey: false },
		);

		expect(
			screen.queryByRole("menuitem", { name: t("spaces.pane.collapseAll") }),
		).toBeNull();
		fireEvent.click(
			await screen.findByRole("menuitem", {
				name: t("spaces.pane.expandAll"),
			}),
		);
		expect(onExpandAll).toHaveBeenCalledOnce();
	});

	it("offers stable, updated, and status ordering through one options value", async () => {
		const onChange = vi.fn();
		render(
			<SpacesViewOptionsMenu
				value={DEFAULT_SPACES_VIEW_OPTIONS}
				onChange={onChange}
				filterChoices={NO_FILTER_CHOICES}
				canExpandAll={false}
				canCollapseAll={false}
				onExpandAll={vi.fn()}
				onCollapseAll={vi.fn()}
			/>,
		);

		fireEvent.pointerDown(
			screen.getByRole("button", { name: t("spaces.pane.viewOptions") }),
			{ button: 0, ctrlKey: false },
		);
		fireEvent.pointerMove(
			await screen.findByRole("menuitem", { name: t("spaces.pane.ordering") }),
			{ pointerType: "mouse" },
		);

		const paneOrder = await screen.findByRole("menuitemradio", {
			name: t("spaces.pane.orderByPane"),
		});
		expect(paneOrder.getAttribute("aria-checked")).toBe("true");
		expect(
			screen.getByRole("menuitemradio", { name: t("spaces.pane.status") }),
		).toBeTruthy();
		fireEvent.click(
			await screen.findByRole("menuitemradio", {
				name: t("spaces.pane.updated"),
			}),
		);
		expect(onChange).toHaveBeenCalledWith({
			...DEFAULT_SPACES_VIEW_OPTIONS,
			orderBy: "updated",
		});
	});

	it("toggles metadata and facet values through independent check items", async () => {
		const onChange = vi.fn();
		render(
			<SpacesViewOptionsMenu
				value={DEFAULT_SPACES_VIEW_OPTIONS}
				onChange={onChange}
				filterChoices={{
					status: ["blocked", "working"],
					environment: ["local", "ssh"],
					repository: [{ value: "repo-1", label: "Dure" }],
					location: [{ value: "location-1", label: "/repo" }],
					source: ["provider:codex", "shell"],
				}}
				canExpandAll={false}
				canCollapseAll={false}
				onExpandAll={vi.fn()}
				onCollapseAll={vi.fn()}
			/>,
		);
		fireEvent.pointerDown(
			screen.getByRole("button", { name: t("spaces.pane.viewOptions") }),
			{ button: 0, ctrlKey: false },
		);
		fireEvent.pointerMove(
			screen.getByRole("menuitem", { name: t("spaces.pane.show") }),
			{ pointerType: "mouse" },
		);
		fireEvent.click(
			await screen.findByRole("menuitemcheckbox", {
				name: t("spaces.pane.machine"),
			}),
		);
		expect(onChange).toHaveBeenCalledWith({
			...DEFAULT_SPACES_VIEW_OPTIONS,
			visibleFields: ["updated", "branch", "machine", "details", "gitStatus"],
		});

		fireEvent.keyDown(
			screen.getByRole("menuitemcheckbox", {
				name: t("spaces.pane.machine"),
			}),
			{ key: "ArrowLeft" },
		);
		fireEvent.pointerMove(
			await screen.findByRole("menuitem", { name: t("spaces.pane.status") }),
			{ pointerType: "mouse" },
		);
		fireEvent.click(
			await screen.findByRole("menuitemcheckbox", {
				name: t("agents.status.approvalRequired"),
			}),
		);
		expect(onChange).toHaveBeenCalledWith({
			...DEFAULT_SPACES_VIEW_OPTIONS,
			filters: {
				...DEFAULT_SPACES_VIEW_OPTIONS.filters,
				status: ["blocked"],
			},
		});
	});

	it("says which Show fields draw nothing for the listed rows, and keeps them toggleable", async () => {
		const onChange = vi.fn();
		render(
			<SpacesViewOptionsMenu
				value={DEFAULT_SPACES_VIEW_OPTIONS}
				onChange={onChange}
				filterChoices={NO_FILTER_CHOICES}
				fieldsPresent={new Set(["environment", "details"])}
				canExpandAll={false}
				canCollapseAll={false}
				onExpandAll={vi.fn()}
				onCollapseAll={vi.fn()}
			/>,
		);
		fireEvent.pointerDown(
			screen.getByRole("button", { name: t("spaces.pane.viewOptions") }),
			{ button: 0, ctrlKey: false },
		);
		fireEvent.pointerMove(
			screen.getByRole("menuitem", { name: t("spaces.pane.show") }),
			{ pointerType: "mouse" },
		);
		// Branch: on, but no listed row has one — hinted, still on, still toggleable.
		const items = await screen.findAllByRole("menuitemcheckbox");
		const branch = items.find((item) =>
			item.textContent?.startsWith(t("spaces.pane.branch")),
		) as HTMLElement;
		expect(branch.textContent).toContain(t("spaces.pane.nothingToShow"));
		expect(branch.getAttribute("aria-checked")).toBe("true");
		fireEvent.click(branch);
		expect(onChange).toHaveBeenCalledWith({
			...DEFAULT_SPACES_VIEW_OPTIONS,
			visibleFields: ["updated", "details", "gitStatus"],
		});
		// Details has rows to show, and Space folds a tier: no hint on either.
		for (const label of [t("spaces.pane.details"), t("spaces.pane.space")]) {
			const item = items.find((candidate) =>
				candidate.textContent?.startsWith(label),
			) as HTMLElement;
			expect(item.textContent).toBe(label);
		}
	});

	it("shows spaces by default and turns the tier off through the Show list", async () => {
		const onChange = vi.fn();
		render(
			<SpacesViewOptionsMenu
				value={DEFAULT_SPACES_VIEW_OPTIONS}
				onChange={onChange}
				filterChoices={NO_FILTER_CHOICES}
				canExpandAll={false}
				canCollapseAll={false}
				onExpandAll={vi.fn()}
				onCollapseAll={vi.fn()}
			/>,
		);
		fireEvent.pointerDown(
			screen.getByRole("button", { name: t("spaces.pane.viewOptions") }),
			{ button: 0, ctrlKey: false },
		);
		fireEvent.pointerMove(
			screen.getByRole("menuitem", { name: t("spaces.pane.show") }),
			{ pointerType: "mouse" },
		);
		const space = await screen.findByRole("menuitemcheckbox", {
			name: t("spaces.pane.space"),
		});
		expect(space.getAttribute("aria-checked")).toBe("true");
		fireEvent.click(space);
		expect(onChange).toHaveBeenCalledWith({
			...DEFAULT_SPACES_VIEW_OPTIONS,
			showSpaces: false,
		});
	});

	it("does not offer status ordering inside status buckets and shows pane order in its place", async () => {
		render(
			<SpacesViewOptionsMenu
				value={{
					...DEFAULT_SPACES_VIEW_OPTIONS,
					groupBy: "status",
					orderBy: "status",
				}}
				onChange={vi.fn()}
				filterChoices={NO_FILTER_CHOICES}
				canExpandAll={false}
				canCollapseAll={false}
				onExpandAll={vi.fn()}
				onCollapseAll={vi.fn()}
			/>,
		);
		fireEvent.pointerDown(
			screen.getByRole("button", { name: t("spaces.pane.viewOptions") }),
			{ button: 0, ctrlKey: false },
		);
		fireEvent.pointerMove(
			await screen.findByRole("menuitem", { name: t("spaces.pane.ordering") }),
			{ pointerType: "mouse" },
		);
		const paneOrder = await screen.findByRole("menuitemradio", {
			name: t("spaces.pane.orderByPane"),
		});
		expect(paneOrder.getAttribute("aria-checked")).toBe("true");
		expect(
			screen.getByRole("menuitemradio", { name: t("spaces.pane.updated") }),
		).toBeTruthy();
		expect(
			screen.queryByRole("menuitemradio", { name: t("spaces.pane.status") }),
		).toBeNull();
	});

	it.each([
		// The Local/SSH band states the environment; the machine still names
		// the host.
		{ groupBy: "environment" as const, gone: ["environment"] },
		// A location heading is "host · path": machine and environment both.
		{ groupBy: "location" as const, gone: ["environment", "machine"] },
		// The space tree's top heading is the space; there is no tier to fold.
		{ groupBy: "space" as const, gone: ["space"] },
	])(
		"takes what the $groupBy headings state off Show",
		async ({ groupBy, gone }) => {
			render(
				<SpacesViewOptionsMenu
					value={{ ...DEFAULT_SPACES_VIEW_OPTIONS, groupBy }}
					onChange={vi.fn()}
					filterChoices={NO_FILTER_CHOICES}
					canExpandAll={false}
					canCollapseAll={false}
					onExpandAll={vi.fn()}
					onCollapseAll={vi.fn()}
				/>,
			);
			fireEvent.pointerDown(
				screen.getByRole("button", { name: t("spaces.pane.viewOptions") }),
				{ button: 0, ctrlKey: false },
			);
			fireEvent.pointerMove(
				screen.getByRole("menuitem", { name: t("spaces.pane.show") }),
				{ pointerType: "mouse" },
			);
			expect(
				await screen.findByRole("menuitemcheckbox", {
					name: t("spaces.pane.branch"),
				}),
			).toBeTruthy();
			for (const field of ["environment", "machine", "space"] as const) {
				const item = screen.queryByRole("menuitemcheckbox", {
					name: t(`spaces.pane.${field}`),
				});
				if (gone.includes(field)) expect(item).toBeNull();
				else expect(item).toBeTruthy();
			}
		},
	);

	it("marks active filters on the trigger and resets filters plus Show defaults", () => {
		const onChange = vi.fn();
		const value = {
			...DEFAULT_SPACES_VIEW_OPTIONS,
			visibleFields: ["machine"] as const,
			filters: {
				...DEFAULT_SPACES_VIEW_OPTIONS.filters,
				environment: ["ssh"] as const,
			},
		};
		render(
			<SpacesViewOptionsMenu
				value={value}
				onChange={onChange}
				filterChoices={{
					...NO_FILTER_CHOICES,
					environment: ["ssh"],
				}}
				canExpandAll={false}
				canCollapseAll={false}
				onExpandAll={vi.fn()}
				onCollapseAll={vi.fn()}
			/>,
		);
		const trigger = screen.getByRole("button", {
			name: t("spaces.pane.viewOptions"),
		});
		expect(trigger.getAttribute("data-active-filters")).toBe("true");
		fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
		const reset = screen
			.getByText(t("spaces.pane.reset"))
			.closest('[role="menuitem"]');
		expect(reset?.getAttribute("data-disabled")).toBeNull();
		fireEvent.click(reset as Element);
		expect(onChange).toHaveBeenCalledWith(DEFAULT_SPACES_VIEW_OPTIONS);
	});

	it("offers every grouping backed by canonical row facets", async () => {
		const onChange = vi.fn();
		render(
			<SpacesViewOptionsMenu
				value={DEFAULT_SPACES_VIEW_OPTIONS}
				onChange={onChange}
				filterChoices={NO_FILTER_CHOICES}
				canExpandAll={false}
				canCollapseAll={false}
				onExpandAll={vi.fn()}
				onCollapseAll={vi.fn()}
			/>,
		);

		fireEvent.pointerDown(
			screen.getByRole("button", { name: t("spaces.pane.viewOptions") }),
			{ button: 0, ctrlKey: false },
		);
		fireEvent.pointerMove(
			await screen.findByRole("menuitem", { name: t("spaces.pane.grouping") }),
			{ pointerType: "mouse" },
		);

		expect(
			await screen.findByRole("menuitemradio", {
				name: t("spaces.pane.location"),
			}),
		).toBeTruthy();
		expect(
			screen.getByRole("menuitemradio", {
				name: t("spaces.pane.environment"),
			}),
		).toBeTruthy();
		expect(
			await screen.findByRole("menuitemradio", {
				name: t("spaces.pane.updated"),
			}),
		).toBeTruthy();
		expect(
			screen.getByRole("menuitemradio", { name: t("spaces.pane.status") }),
		).toBeTruthy();
		fireEvent.click(
			screen.getByRole("menuitemradio", {
				name: t("spaces.pane.environment"),
			}),
		);
		expect(onChange).toHaveBeenCalledWith({
			...DEFAULT_SPACES_VIEW_OPTIONS,
			groupBy: "environment",
		});
	});
});
