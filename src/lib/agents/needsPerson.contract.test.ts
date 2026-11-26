// Coverage contract: every surface that counts or lists who needs a person
// goes through the one needs-person authority, so the rail badge, Next up,
// the Dock badge and the Spaces rollups cannot disagree.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..", "..");

function source(path: string): string {
	return readFileSync(join(SRC, path), "utf8");
}

function* sources(dir: string): Generator<string> {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) yield* sources(full);
		else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) yield full;
	}
}

describe("needs-person coverage", () => {
	it("keeps the display-state rule inside the authority", () => {
		const outside = [...sources(SRC)]
			.map((file) => relative(SRC, file))
			.filter((file) => file !== join("lib", "agents", "needsPerson.ts"))
			.filter((file) =>
				/NEEDS_PERSON_DISPLAY_STATES|NEEDS_PERSON_REASON_BY_STATE|ATTENTION_DISPLAY_STATES/.test(
					source(file),
				),
			);
		expect(outside).toEqual([]);
	});

	it("routes every counting surface through the authority", () => {
		// Next up, and through readNextUp the Dock badge and the shortcut.
		expect(source("lib/agents/nextUp.ts")).toContain("NeedsPersonMap");
		expect(source("lib/agents/nextUpNavigation.ts")).toContain("readNeedsPerson()");
		expect(source("lib/agents/appIconBadge.ts")).toContain("readNextUp()");
		expect(source("components/agents/useNextUp.ts")).toContain("useNeedsPerson()");
		// The rail badge.
		expect(source("components/sidebar/ActivityRail.tsx")).toContain(
			"useNeedsPerson().size",
		);
		// The Spaces rows carry the authority's verdict, and the heading rollups
		// and status groups read only that.
		expect(source("components/spaces/useSpaces.ts")).toContain("useNeedsPerson()");
		for (const file of ["lib/spaces/spacesHierarchy.ts", "lib/spaces/spacesViewProjection.ts"]) {
			expect(source(file)).toContain("countsTowardNeedsPersonRollup(row)");
		}
		// The phone's home: its Needs you and its results read the same
		// authority and predicate over what the computer reported.
		const phoneHome = source("../mobile/src/homeProjection.ts");
		expect(phoneHome).toContain("needsPersonOf(");
		expect(phoneHome).toContain("currentEpochFailure(");
		expect(phoneHome).toContain("hasResult(");
	});
});
