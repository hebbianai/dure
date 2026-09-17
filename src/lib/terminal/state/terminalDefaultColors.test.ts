import { describe, expect, it } from "vitest";
import { terminalDefaultColors } from "./terminalDefaultColors";

describe("terminalDefaultColors", () => {
	it("projects exact 24-bit foreground and background values", () => {
		expect(
			terminalDefaultColors({
				foreground: "#123456",
				background: "#654321",
			}),
		).toEqual({ foregroundRgb: 0x123456, backgroundRgb: 0x654321 });
	});

	it("rejects values that are not opaque sRGB colors", () => {
		expect(() =>
			terminalDefaultColors({
				foreground: "rgb(18, 52, 86)",
				background: "#000000",
			}),
		).toThrow("terminal default color must be #rrggbb");
	});
});
