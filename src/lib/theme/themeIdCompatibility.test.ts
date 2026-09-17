import { describe, expect, it } from "vitest";
import {
	canonicalThemeId,
	normalizePersistedThemeScheme,
} from "@/lib/theme/themeIdCompatibility";

describe("theme id compatibility", () => {
	it("maps only exact pre-rename built-in ids", () => {
		expect(canonicalThemeId("hebbian-dark")).toBe("dure-dark");
		expect(canonicalThemeId("hebbian-light")).toBe("dure-light");
		expect(canonicalThemeId("hebbian-my-theme")).toBe("hebbian-my-theme");
	});

	it("normalizes valid slots and rejects malformed persisted schemes", () => {
		expect(
			normalizePersistedThemeScheme({
				dark: "hebbian-dark",
				light: "custom-light",
			}),
		).toEqual({ dark: "dure-dark", light: "custom-light" });
		expect(normalizePersistedThemeScheme("hebbian-dark")).toBeUndefined();
		expect(normalizePersistedThemeScheme({ dark: 42 })).toBeUndefined();
	});
});
