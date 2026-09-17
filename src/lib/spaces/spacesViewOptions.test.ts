import { describe, expect, it } from "vitest";
import {
	DEFAULT_SPACES_VIEW_OPTIONS,
	effectiveSpacesOrdering,
	normalizeSpacesViewOptions,
	SPACES_STATUS_FILTER_VALUES,
} from "@/lib/spaces/spacesViewOptions";

it("exposes only states produced by the current Host projection", () => {
	expect(SPACES_STATUS_FILTER_VALUES).not.toContain("done");
});

describe("effectiveSpacesOrdering", () => {
	it("falls back to pane order where the status buckets already impose the stored ordering", () => {
		const byStatus = { ...DEFAULT_SPACES_VIEW_OPTIONS, orderBy: "status" as const };
		expect(effectiveSpacesOrdering(byStatus)).toBe("status");
		expect(effectiveSpacesOrdering({ ...byStatus, groupBy: "status" })).toBe("stable");
		// Day buckets leave time ordering meaningful inside "Today".
		expect(
			effectiveSpacesOrdering({
				...DEFAULT_SPACES_VIEW_OPTIONS,
				groupBy: "updated",
				orderBy: "updated",
			}),
		).toBe("updated");
	});
});

describe("normalizeSpacesViewOptions", () => {
	it("preserves all-off and independent detail and Git preferences across rehydration", () => {
		expect(normalizeSpacesViewOptions({ visibleFields: [] }).visibleFields).toEqual([]);
		expect(normalizeSpacesViewOptions({ visibleFields: ["gitStatus", "details"] }).visibleFields)
			.toEqual(["details", "gitStatus"]);
		expect(normalizeSpacesViewOptions({ visibleFields: ["machine"] }).visibleFields)
			.toEqual(["machine"]);
		// The space is a tier toggle, not a field: a persisted "space" field
		// falls through, and the toggle reads absent as shown.
		expect(
			normalizeSpacesViewOptions({ visibleFields: ["environment", "space", "branch"] })
				.visibleFields,
		).toEqual(["environment", "branch"]);
		expect(normalizeSpacesViewOptions({}).showSpaces).toBe(true);
		expect(normalizeSpacesViewOptions({ showSpaces: false }).showSpaces).toBe(false);
	});
	it("keeps a supported grouping and rejects malformed input", () => {
		expect(normalizeSpacesViewOptions({ groupBy: "space" })).toEqual({
			...DEFAULT_SPACES_VIEW_OPTIONS,
			groupBy: "space",
		});
		expect(normalizeSpacesViewOptions({ groupBy: "machine" })).toEqual(
			DEFAULT_SPACES_VIEW_OPTIONS,
		);
		expect(normalizeSpacesViewOptions(["space"])).toEqual(
			DEFAULT_SPACES_VIEW_OPTIONS,
		);
	});

	it("migrates the former project/space preference", () => {
		expect(normalizeSpacesViewOptions(undefined, "space")).toEqual({
			...DEFAULT_SPACES_VIEW_OPTIONS,
			groupBy: "space",
		});
		expect(normalizeSpacesViewOptions(undefined, "project")).toEqual({
			...DEFAULT_SPACES_VIEW_OPTIONS,
		});
	});

	it("gives the canonical object priority over a legacy byte", () => {
		expect(
			normalizeSpacesViewOptions({ groupBy: "repository" }, "space"),
		).toEqual(DEFAULT_SPACES_VIEW_OPTIONS);
	});

	it("normalizes grouping and ordering independently", () => {
		expect(
			normalizeSpacesViewOptions({ groupBy: "bogus", orderBy: "updated" }),
		).toEqual({ ...DEFAULT_SPACES_VIEW_OPTIONS, orderBy: "updated" });
		expect(
			normalizeSpacesViewOptions({ groupBy: "space", orderBy: "bogus" }),
		).toEqual({ ...DEFAULT_SPACES_VIEW_OPTIONS, groupBy: "space" });
		expect(
			normalizeSpacesViewOptions({ groupBy: "repository", orderBy: "status" }),
		).toEqual({ ...DEFAULT_SPACES_VIEW_OPTIONS, orderBy: "status" });
	});

	it("preserves independently selected metadata and facet filters", () => {
		expect(
			normalizeSpacesViewOptions({
				groupBy: "repository",
				orderBy: "updated",
				visibleFields: ["updated", "machine"],
				filters: {
					status: ["blocked", "working"],
					environment: ["ssh"],
					repository: ['["project","repo-1"]'],
					location: ['["location","host-1","/repo"]'],
					source: ["provider:codex"],
				},
			}),
		).toEqual({
			groupBy: "repository",
			orderBy: "updated",
			visibleFields: ["updated", "machine"],
			showSpaces: true,
			filters: {
				status: ["blocked", "working"],
				environment: ["ssh"],
				repository: ['["project","repo-1"]'],
				location: ['["location","host-1","/repo"]'],
				source: ["provider:codex"],
			},
		});
	});

	it("drops the retired done display filter from persisted preferences", () => {
		expect(
			normalizeSpacesViewOptions({ filters: { status: ["done", "waiting"] } }),
		).toMatchObject({ filters: { status: ["waiting"] } });
	});

	it("canonicalizes persisted field order and removes duplicates", () => {
		expect(
			normalizeSpacesViewOptions({
				visibleFields: ["machine", "updated", "machine", "branch"],
			}),
		).toMatchObject({
			visibleFields: ["updated", "branch", "machine"],
		});
	});

	it("keeps supported facet grouping choices", () => {
		expect(normalizeSpacesViewOptions({ groupBy: "location" })).toEqual({
			...DEFAULT_SPACES_VIEW_OPTIONS,
			groupBy: "location",
		});
		expect(normalizeSpacesViewOptions({ groupBy: "environment" })).toEqual({
			...DEFAULT_SPACES_VIEW_OPTIONS,
			groupBy: "environment",
		});
		expect(normalizeSpacesViewOptions({ groupBy: "updated" })).toEqual({
			...DEFAULT_SPACES_VIEW_OPTIONS,
			groupBy: "updated",
		});
		expect(normalizeSpacesViewOptions({ groupBy: "status" })).toEqual({
			...DEFAULT_SPACES_VIEW_OPTIONS,
			groupBy: "status",
		});
	});
});
