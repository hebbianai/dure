import { describe, expect, it } from "vitest";
import {
	formatWorkedDuration,
	opaqueJsonText,
} from "@/lib/agents/chat/chatFormat";
import { t } from "@/lib/i18n";

describe("opaqueJsonText", () => {
	it("pretty-prints serializable payloads", () => {
		expect(opaqueJsonText({ a: 1 })).toBe('{\n  "a": 1\n}');
	});

	it("degrades to the opaque notice for unserializable payloads", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(opaqueJsonText(cyclic)).toBe(t("agents.chat.opaqueValue"));
	});
});

describe("formatWorkedDuration", () => {
	it("formats seconds, minutes, and hours", () => {
		expect(formatWorkedDuration(45_000)).toBe("45s");
		expect(formatWorkedDuration(125_000)).toBe("2m 05s");
		expect(formatWorkedDuration(3_720_000)).toBe("1h 02m");
	});
});
