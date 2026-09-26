import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	renderHomeScreen,
	type CensusModel,
	type CensusActions,
} from "./censusView";
import {
	loadHomeViewOptions,
	saveHomeViewOptions,
} from "./homeViewPreferences";
import { t } from "./i18n";
import type { HubProbeSession } from "./ipc";
import { projectHome } from "./homeProjection";
import type { SpacesGrouping } from "@/lib/spaces/spacesViewOptions";
import { renderSessionSwitcher } from "./sessionSwitcher";

const now = 1_700_000_000_000;
function session(
	id: string,
	activityAt: number,
	provider: "claude" | "codex",
	hostId?: string,
): HubProbeSession {
	return {
		session_id: id,
		session_name: id,
		workspace_id: "qa",
		session_class: "standalone",
		lifecycle: "ready",
		provider_id: provider,
		runner_principal: "qa",
		runner_instance: "i",
		channel_epoch: "e",
		host_instance_id: "h",
		terminal_epoch: "t",
		capabilities: [],
		ready: true,
		box_id: hostId ?? "this-laptop",
		box_label: hostId ?? "QA Mac",
		presentation: {
			activityAt,
			provider,
			kind: "agent",
			hostId,
			hostLabel: hostId ?? "QA Mac",
			projectId: id === "three" ? "p2" : "p1",
			projectName: id === "three" ? "Other" : "Dure",
			cwd: `/repo/${id}`,
			detail: `Detail ${id}`,
			displayState: id === "two" ? "blocked" : "working",
			git: { worktree: 51, committed: 2, ahead: 0, behind: 6 },
		},
	};
}
function fixture(): CensusModel {
	return {
		census: [],
		hubs: [
			{
				hubId: "qa",
				hubLabel: "QA Mac",
				reachable: true,
				sessions: [
					session("one", now - 180_000, "claude"),
					session("two", now - 60_000, "codex"),
					session("three", now - 3600_000, "codex", "remote"),
				],
			},
		],
		failures: [],
		busy: false,
		emptyMessage: "",
		layout: {
			placements: {
				one: {
					desktop: "Work",
					project: "Dure",
					order: 0,
					branch: "feature/one",
				},
				two: {
					desktop: "Personal",
					project: "Dure",
					order: 0,
					branch: "feature/two",
				},
				three: { desktop: "Personal", project: "Other", order: 1 },
			},
			desktop_order: ["Work", "Personal"],
		},
	};
}
let model: CensusModel;
const noop = () => {};
let actions: CensusActions;
function draw() {
	document.body.replaceChildren(renderHomeScreen(model, actions));
}
/**
 * An item inside one axis's card — the same label can sit in two axes. The
 * card opens from its row when it is not already the open one.
 */
function clickIn(facet: string, label: string) {
	if (!document.querySelector(`.home-menu__card[data-facet="${facet}"]`)) {
		const row = document.querySelector<HTMLButtonElement>(`[data-row="${facet}"]`);
		if (!row) throw new Error(`Missing row ${facet}`);
		row.click();
	}
	const button = [
		...document.querySelectorAll<HTMLButtonElement>(
			`.home-menu__card[data-facet="${facet}"] button`,
		),
	].find((node) => node.textContent === label);
	if (!button) throw new Error(`Missing ${label} in ${facet}`);
	button.click();
}

function click(label: string) {
	const button = [
		...document.querySelectorAll<HTMLButtonElement>("button"),
	].find(
		(node) =>
			node.textContent === label || node.getAttribute("aria-label") === label,
	);
	expect(button, label).toBeDefined();
	button?.click();
}
function titles() {
	return [...document.querySelectorAll(".session-row__title")].map(
		(node) => node.textContent,
	);
}

function pinSession(id: string, pinned = true) {
	const row = model.hubs[0].sessions.find(session => session.session_id === id)!;
	row.presentation = { ...row.presentation, pinned };
}

it("keeps desktop-pinned panes above every Space without duplicating them", () => {
	pinSession("three");
	draw();
	expect(titles()).toEqual(["three", "one"]);
	expect(document.querySelector(".list__heading")?.textContent).toContain(t("spaces.pane.pinned"));
	expect(document.querySelector(".session-row__meta")?.textContent).toContain("Personal");
	click("Personal");
	expect(titles()).toEqual(["three", "two"]);
	pinSession("three", false);
	draw();
	expect(titles()).toEqual(["two", "three"]);
	expect(document.querySelector(".list__heading")).toBeNull();
});

it("applies filters before showing pins and preserves ordering within the pinned band", () => {
	pinSession("one");
	pinSession("three");
	model = { ...model, viewOptions: { ...loadHomeViewOptions(), orderBy: "updated" } };
	draw();
	expect(titles()).toEqual(["one", "three"]);
	expect(document.querySelector(".home__empty")).toBeNull();
	model = { ...model, viewOptions: {
		...model.viewOptions!, filters: { ...model.viewOptions!.filters, source: ["provider:codex"] },
	} };
	draw();
	expect(titles()).toEqual(["three", "two"]);
});

it("keeps pinned panes first in the session switcher and opens their original target", () => {
	pinSession("three");
	const options = loadHomeViewOptions();
	const open = vi.fn();
	const switcher = renderSessionSwitcher(projectHome(model, options, now).groups, options, "one", undefined, now, open);
	expect([...switcher.querySelectorAll(".session-row__title")].map(row => row.textContent)).toEqual(["three", "one"]);
	switcher.querySelector<HTMLButtonElement>('[data-session-id="three"]')!.click();
	expect(open).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "three" }));
});

it("renders only pinned matches in the switcher and keeps unavailable pins disabled", () => {
	pinSession("three");
	const options = loadHomeViewOptions();
	const projected = projectHome(model, options, now);
	const pinned = projected.groups.find(group => group.pinned)!;
	expect(pinned.rows).toHaveLength(1);
	const switcher = renderSessionSwitcher([pinned], options, "three", undefined, now, vi.fn());
	expect(switcher.querySelector('[data-session-id="three"]')?.getAttribute("aria-current")).toBe("true");
	const row = model.hubs[0].sessions.find(session => session.session_id === "three")!;
	row.ready = false;
	row.lifecycle = "exited";
	draw();
	expect(document.querySelector<HTMLButtonElement>('[data-session-id="three"]')?.disabled).toBe(true);
});
beforeEach(() => {
	localStorage.clear();
	vi.useFakeTimers();
	vi.setSystemTime(now);
	model = fixture();
	actions = {
		open: noop,
		pair: noop,
		settings: noop,
		refresh: noop,
		hold: noop,
		selectDesktop: (desktop) => {
			model = { ...model, desktop };
			draw();
		},
		viewMenu: (viewMenu) => {
			model = { ...model, viewMenu };
			draw();
		},
		changeView: (viewOptions) => {
			saveHomeViewOptions(viewOptions);
			model = {
				...model,
				viewOptions,
				desktop:
					model.viewOptions?.groupBy === viewOptions.groupBy
						? model.desktop
						: undefined,
			};
			draw();
		},
	};
});
afterEach(() => {
	vi.useRealTimers();
	localStorage.clear();
	document.body.replaceChildren();
});

it("defaults to Space and changes the chip axis through the menu, persisting the choice", () => {
	draw();
	expect(titles()).toEqual(["one"]);
	click(t("spaces.pane.viewOptions"));
	clickIn("grouping", t("spaces.pane.groupByRepository"));
	expect(loadHomeViewOptions().groupBy).toBe("repository");
	// The sheet has no close button: the scrim dismisses it, as it does 추가.
	document.querySelector<HTMLElement>(".home-menu")?.click();
	expect(
		[...document.querySelectorAll(".tab")].map((node) => node.textContent),
	).toEqual(["Dure", "Other"]);
	expect(titles()).toEqual(["one", "two"]);
	click("Other");
	expect(titles()).toEqual(["three"]);
	model = { ...fixture(), viewOptions: loadHomeViewOptions() };
	draw();
	expect(titles()).toEqual(["one", "two"]);
});

it("orders by observed activity and lets Show hide branch, details, Git, and age", () => {
	model = {
		...model,
		viewOptions: {
			...loadHomeViewOptions(),
			groupBy: "repository",
			orderBy: "updated",
		},
	};
	draw();
	expect(titles()).toEqual(["two", "one"]);
	expect(document.querySelector(".session-row__git")?.textContent).toBe(
		"C2W51↓6",
	);
	click(t("spaces.pane.viewOptions"));
	for (const key of ["branch", "details", "gitStatus", "updated"])
		clickIn("show", t(`spaces.pane.${key}`));
	expect(document.querySelector(".session-row__stats")).toBeNull();
	expect(document.querySelector(".session-row__meta")?.textContent).toBe(
		"Personal",
	);
	clickIn("show", t("common.space"));
	expect(document.querySelector(".session-row__meta")).toBeNull();
});

it("persists Space display across Home and the switcher without changing session targets", () => {
	model = {
		...model,
		viewOptions: {
			...loadHomeViewOptions(),
			groupBy: "repository",
			visibleFields: [],
		},
	};
	draw();
	expect(titles()).toEqual(["one", "two"]);
	expect(
		[...document.querySelectorAll(".session-row__meta")].map(
			(node) => node.textContent,
		),
	).toEqual(["Work", "Personal"]);
	click(t("spaces.pane.viewOptions"));
	clickIn("show", t("common.space"));
	expect(loadHomeViewOptions().showSpaces).toBe(false);
	model = { ...fixture(), viewOptions: loadHomeViewOptions() };
	draw();
	expect(titles()).toEqual(["one", "two"]);
	expect(document.querySelector(".session-row__meta")).toBeNull();

	const options = loadHomeViewOptions();
	const open = vi.fn();
	const groups = projectHome(model, options, now).groups;
	const switcher = renderSessionSwitcher(
		groups,
		options,
		"one",
		undefined,
		now,
		open,
	);
	expect(switcher.querySelector(".session-row__meta")).toBeNull();
	const current = switcher.querySelector<HTMLButtonElement>(
		'[data-session-id="one"]',
	)!;
	expect(current.disabled).toBe(true);
	expect(current.getAttribute("aria-current")).toBe("true");
	current.click();
	expect(open).not.toHaveBeenCalled();
	switcher.querySelector<HTMLButtonElement>('[data-session-id="two"]')!.click();
	expect(open).toHaveBeenCalledExactlyOnceWith(groups[0].rows[1].row);

	click(t("spaces.pane.viewOptions"));
	clickIn("show", t("common.space"));
	const restored = loadHomeViewOptions();
	expect(restored.showSpaces).toBe(true);
	expect(restored.visibleFields).toEqual([]);
	expect(document.querySelector(".session-row__meta")?.textContent).toBe(
		"Work",
	);
	expect(
		renderSessionSwitcher(
			groups,
			restored,
			"one",
			undefined,
			now,
			open,
		).querySelector(".session-row__meta")?.textContent,
	).toBe("Work");
});

it.each<{ groupBy: SpacesGrouping; expected: string[] }>([
	{ groupBy: "space", expected: [t("spaces.pane.environmentLocal")] },
	{ groupBy: "repository", expected: [t("spaces.pane.environmentLocal"), "Work"] },
	{ groupBy: "environment", expected: ["Work"] },
	{ groupBy: "location", expected: ["Work"] },
])(
	"omits $groupBy heading metadata in both Home and the switcher",
	({ groupBy, expected }) => {
		const options = {
			...loadHomeViewOptions(),
			groupBy,
			visibleFields: ["environment", "machine"] as const,
		};
		model = { ...model, viewOptions: options };
		draw();
		const switcher = renderSessionSwitcher(
			projectHome(model, options, now).groups,
			options,
			"one",
			undefined,
			now,
			noop,
		);
		for (const container of [document, switcher]) {
			const fields = [
				...container.querySelectorAll(
					'[data-session-id="one"] .session-row__field',
				),
			].map((node) => node.textContent);
			expect(fields).toEqual(expected);
		}
	},
);

it("keeps a suppressed Show preference when changing grouping and reloading", () => {
	model = {
		...model,
		viewOptions: {
			...loadHomeViewOptions(),
			groupBy: "repository",
			visibleFields: ["environment"],
		},
	};
	draw();
	click(t("spaces.pane.viewOptions"));
	clickIn("grouping", t("spaces.pane.environment"));
	expect(
		[...document.querySelectorAll('[data-facet="show"] [role="menuitemcheckbox"]')].some(
			(node) => node.textContent === t("spaces.pane.environment"),
		),
	).toBe(false);
	expect(loadHomeViewOptions().visibleFields).toEqual(["environment"]);
	clickIn("grouping", t("spaces.pane.groupByRepository"));
	model = {
		...fixture(),
		viewOptions: loadHomeViewOptions(),
		viewMenu: "show",
	};
	draw();
	const environment = [
		...document.querySelectorAll('[data-facet="show"] [role="menuitemcheckbox"]'),
	].find((node) => node.textContent === t("spaces.pane.environment"));
	expect(environment?.getAttribute("aria-checked")).toBe("true");
	expect(document.querySelector(".session-row__meta")?.textContent).toContain(
		t("spaces.pane.environmentLocal"),
	);
});

it("shows a session's age only while it is not working, as the desktop row does", () => {
	draw();
	// "one" is working: the loader in its lead says now, so no age beside it.
	expect(titles()).toEqual(["one"]);
	expect(document.querySelector(".session-row__updated")).toBeNull();
	click(t("spaces.pane.viewOptions"));
	clickIn("grouping", t("spaces.pane.groupByRepository"));
	document.querySelector<HTMLElement>(".home-menu")?.click();
	// "two" is blocked, waiting: its age shows; "one" still has none.
	expect(titles()).toEqual(["one", "two"]);
	const ages = [...document.querySelectorAll(".session-row")].map(
		(row) => row.querySelector(".session-row__updated") !== null,
	);
	expect(ages).toEqual([false, true]);
});

it("combines filters and resets a no-match view", () => {
	model = {
		...model,
		viewOptions: { ...loadHomeViewOptions(), groupBy: "repository" },
	};
	draw();
	click(t("spaces.pane.viewOptions"));
	clickIn("status", t("agents.status.approvalRequired"));
	expect(titles()).toEqual(["two"]);
	clickIn("source", "claude");
	expect(titles()).toEqual([]);
	expect(document.querySelector(".home__empty")?.textContent).toContain(
		t("spaces.empty.noMatches"),
	);
	click(t("spaces.pane.resetFilters"));
	expect(titles()).toEqual(["one", "two"]);
});

it("uses the hub presentation when the preferred attach route is direct SSH", () => {
	const original = model.hubs[0].sessions[2];
	model = {
		...model,
		census: [
			{
				serverId: "ssh",
				serverLabel: "Remote",
				reachable: true,
				session: { ...original, session_name: "slug" },
			},
		],
	};
	const groups = projectHome(
		model,
		{ ...loadHomeViewOptions(), groupBy: "environment" },
		now,
	).groups;
	const row = groups.find((group) =>
		group.rows.some((value) => value.row.sessionId === "three"),
	)?.rows[0];
	expect(row?.row.source.kind).toBe("ssh");
	expect(row?.activityAt).toBe(now - 3600_000);
	expect(row?.detail).toBe("Detail three");
});

it("selects a remaining Space when filters remove the current group's rows", () => {
	draw();
	click(t("spaces.pane.viewOptions"));
	clickIn("status", t("agents.status.approvalRequired"));
	expect(
		[...document.querySelectorAll(".tab")].map((node) => node.textContent),
	).toEqual(["Personal"]);
	expect(titles()).toEqual(["two"]);
});
