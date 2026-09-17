import { describe, expect, it } from "vitest";
import { vcsStatusTone } from "./vcsStatusTone";

describe("vcsStatusTone", () => {
	it("reads untracked as new content, not disabled grey", () => {
		expect(vcsStatusTone("??")).toBe("text-vcs-added");
	});

	it("lets a deletion outrank an accompanying modification", () => {
		expect(vcsStatusTone("MD")).toBe("text-vcs-deleted");
		expect(vcsStatusTone("D")).toBe("text-vcs-deleted");
	});

	it("maps the remaining letters with modified as the neutral fallback", () => {
		expect(vcsStatusTone("A")).toBe("text-vcs-added");
		expect(vcsStatusTone("AM")).toBe("text-vcs-added");
		expect(vcsStatusTone("R")).toBe("text-vcs-renamed");
		expect(vcsStatusTone("C")).toBe("text-vcs-renamed");
		expect(vcsStatusTone("M")).toBe("text-vcs-modified");
		expect(vcsStatusTone("T")).toBe("text-vcs-modified");
	});
});
