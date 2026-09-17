import { describe, expect, it } from "vitest";
import { tokensToDtcg } from "./envelope.ts";
import type { TokenInventory } from "./types.ts";

describe("tokensToDtcg", () => {
	it("carries values, dark variants, and scope extensions", () => {
		const inventory: TokenInventory = {
			names: ["--background", "--text-xs"],
			declarations: [
				{ name: "--background", scope: "root", value: "oklch(1 0 0)" },
				{ name: "--background", scope: "dark", value: "oklch(0.145 0 0)" },
				{ name: "--text-xs", scope: "theme-inline", value: "0.8125rem" },
			],
			runtimeNames: [],
			scanErrors: [],
		};
		const dtcg = tokensToDtcg(inventory) as Record<
			string,
			{ $value: string; $type?: string; $extensions: Record<string, unknown> }
		>;
		expect(dtcg.background.$value).toBe("oklch(1 0 0)");
		expect(dtcg.background.$type).toBe("color");
		expect(dtcg.background.$extensions["app.dure.dark"]).toBe("oklch(0.145 0 0)");
		expect(dtcg.background.$extensions["app.dure.scopes"]).toEqual(["dark", "root"]);
		expect(dtcg["text-xs"].$type).toBe("dimension");
		expect(dtcg["text-xs"].$extensions["app.dure.scopes"]).toEqual(["theme-inline"]);
	});
});
