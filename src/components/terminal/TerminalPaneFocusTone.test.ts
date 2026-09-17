import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
	fileURLToPath(new URL("../../index.css", import.meta.url)),
	"utf8",
);

describe("terminal pane focus tone", () => {
	it("never dims pane content when focus moves", () => {
		expect(source).not.toContain("--pane-inactive-opacity");
		expect(source).not.toMatch(
			/\.dv-groupview:not\(\.dv-active-group\)\s*\{[^}]*opacity:/,
		);
	});
});
