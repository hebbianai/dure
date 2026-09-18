import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PROVIDER_IDS } from "../../../cli/lib/contracts/provider-catalog.mjs";

// The native event type names every provider as a closed enum; the catalogue
// is the authority. This keeps the two from drifting without a runtime table.
describe("telemetry provider enum", () => {
	it("names exactly the catalogue's provider ids", () => {
		const source = readFileSync(
			fileURLToPath(
				new URL("../../../src-tauri/src/telemetry/event.rs", import.meta.url),
			),
			"utf8",
		);
		const block = source.match(/pub\(crate\) enum Provider \{([\s\S]*?)\}/);
		expect(block).not.toBeNull();
		// serde's kebab-case: QwenCode -> qwen-code.
		const variants = [
			...(block?.[1] ?? "").matchAll(/^\s*([A-Z][A-Za-z0-9]*),/gm),
		].map((match) =>
			match[1].replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase(),
		);
		expect(variants).toEqual([...PROVIDER_IDS]);
	});
});
