import { describe, expect, it } from "vitest";
import {
	normalizePersistedState,
	persistedSlice,
} from "@/lib/persistence/persistedAppState";
import {
	insertQuickCommandText,
	moveQuickCommand,
	normalizeQuickCommands,
	QUICK_COMMAND_TEXT_LIMIT,
} from "./quickCommands";

const command = {
	id: "review",
	label: " Review ",
	text: "/goal Review\n  preserve whitespace\n",
	appendEnter: false,
};
describe("saved Quick Commands", () => {
	it("round-trips reordered presets without changing their IDs or executable text", () => {
		const commands = normalizeQuickCommands([
			command,
			{
				...command,
				id: "second",
				label: "Second",
				text: "\tkeep\r\n",
				appendEnter: true,
			},
			{ ...command, id: "third", label: "Third" },
		]);
		const moved = moveQuickCommand(commands, "second", -1);
		expect(moved).toEqual([commands[1], commands[0], commands[2]]);
		expect(moved[0]).toBe(commands[1]);
		expect(commands.map((item) => item.id)).toEqual([
			"review",
			"second",
			"third",
		]);
		const state = normalizePersistedState({
			uiPrefs: { quickCommands: moved },
		});
		expect(
			normalizePersistedState(JSON.parse(JSON.stringify(persistedSlice(state))))
				.uiPrefs.quickCommands,
		).toEqual(moved);
		expect(moveQuickCommand(moved, "second", 1)).toEqual(commands);
	});
	it("leaves missing IDs, empty lists and boundaries unchanged", () => {
		const commands = normalizeQuickCommands([command]);
		for (const direction of [-1, 1] as const) {
			expect(moveQuickCommand(commands, command.id, direction)).toBe(commands);
			expect(moveQuickCommand(commands, "removed", direction)).toBe(commands);
		}
		const empty: typeof commands = [];
		expect(moveQuickCommand(empty, command.id, 1)).toBe(empty);
	});
	it.each([
		["", 0, 0, "Review", "Review", 6],
		["Before after", 7, 7, "Review\n", "Before Review\nafter", 14],
		["Before REPLACE after", 7, 14, "Review", "Before Review after", 13],
		["한글 🐋", 3, 5, "\n  🐬\n", "한글 \n  🐬\n", 9],
		["Before after", 7, 7, "CRLF\r\nCR\r", "Before CRLF\nCR\nafter", 15],
	] as const)(
		"inserts exact saved text into %s",
		(draft, start, end, text, expected, caret) => {
			expect(insertQuickCommandText(draft, text, start, end)).toEqual({
				text: expected,
				caret,
			});
		},
	);
	it("round-trips complete text through the existing persisted preferences", () => {
		const state = normalizePersistedState({
			uiPrefs: { quickCommands: [command] },
		});
		const restored = normalizePersistedState(
			JSON.parse(JSON.stringify(persistedSlice(state))),
		);
		expect(restored.uiPrefs.quickCommands).toEqual([
			{ ...command, label: "Review" },
		]);
	});
	it("does not truncate executable text, enable Enter implicitly, or duplicate IDs", () => {
		expect(
			normalizeQuickCommands([
				null,
				{},
				command,
				command,
				{
					...command,
					id: "large",
					text: "a".repeat(QUICK_COMMAND_TEXT_LIMIT + 1),
				},
				{ ...command, id: "implicit", appendEnter: undefined },
				{ ...command, id: "escape", text: "\u001b[200~whoami" },
			]),
		).toEqual([{ ...command, label: "Review" }]);
		expect(normalizeQuickCommands(undefined)).toEqual([]);
	});
});
