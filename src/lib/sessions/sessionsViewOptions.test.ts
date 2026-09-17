import { describe, expect, it } from "vitest";
import {
	DEFAULT_SESSIONS_VIEW_OPTIONS,
	normalizeSessionsViewOptions,
} from "@/lib/sessions/sessionsViewOptions";

describe("normalizeSessionsViewOptions", () => {
	it("keeps each supported view facet", () => {
		expect(
			normalizeSessionsViewOptions({
				groupBy: "provider",
				orderBy: "oldest",
				paneFilter: "open_only",
			}),
		).toEqual({
			groupBy: "provider",
			orderBy: "oldest",
			paneFilter: "open_only",
		});
	});

	it("normalizes malformed facets independently", () => {
		expect(
			normalizeSessionsViewOptions({
				groupBy: "machine",
				orderBy: "name",
				paneFilter: "closed",
			}),
		).toEqual({
			groupBy: "repository",
			orderBy: "name",
			paneFilter: "all",
		});
		expect(normalizeSessionsViewOptions(["provider"])).toEqual(
			DEFAULT_SESSIONS_VIEW_OPTIONS,
		);
	});
});
