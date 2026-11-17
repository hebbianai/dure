import { describe, expect, it } from "vitest";
import {
	formatDureSendHeader,
	splitDureSendHeader,
} from "@/lib/agents/dureSendHeader";

describe("dure send header", () => {
	it("round-trips every header the CLI builds", () => {
		for (const fields of [
			{},
			{ agentName: "lead" },
			{ agentName: "Review worker", label: "ci-bot" },
			{ label: "release · bot" },
		]) {
			const header = formatDureSendHeader(fields);
			expect(splitDureSendHeader(`${header} build is green`)).toEqual({
				agentName: fields.agentName ?? null,
				label: fields.label ?? null,
				body: "build is green",
			});
		}
	});

	it("keeps the text after the header exact", () => {
		expect(
			splitDureSendHeader("[dure send · from lead]   first\n second\n")?.body,
		).toBe("  first\n second\n");
		expect(splitDureSendHeader("[dure send · unregistered]")).toEqual({
			agentName: null,
			label: null,
			body: "",
		});
	});

	it("leaves text without a leading header unmarked", () => {
		for (const text of [
			"build is green",
			" [dure send · from lead] indented",
			"[from ci-bot] older label",
			"[dure send · from lead]glued",
			"quoted [dure send · from lead] later",
		]) {
			expect(splitDureSendHeader(text)).toBeNull();
		}
	});

	it("keeps an Agent name on one line", () => {
		expect(formatDureSendHeader({ agentName: "two\nlines\u001b" })).toBe(
			"[dure send · from two lines]",
		);
		expect(formatDureSendHeader({ agentName: " \n " })).toBe(
			"[dure send · unregistered]",
		);
	});
});
