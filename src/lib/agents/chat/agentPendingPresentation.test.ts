import { describe, expect, it } from "vitest";
import {
	buildPendingQuestionAnswers,
	parsePendingPermissionPresentation,
	parsePendingQuestions,
} from "@/lib/agents/chat/agentPendingPresentation";

describe("agent pending-request presentation", () => {
	it("projects provider permission copy without treating it as approval authority", () => {
		expect(
			parsePendingPermissionPresentation({
				presentation: {
					blockedPath: "/workspace/private",
					description: "Claude will read one file",
					title: "Read file",
				},
				toolName: "Read",
			}),
		).toEqual({
			blockedPath: "/workspace/private",
			description: "Claude will read one file",
			title: "Read file",
		});
	});

	it("preserves AskUserQuestion controls without leaking them into the common contract", () => {
		expect(
			parsePendingQuestions({
				input: {
					questions: [
						{
							allowOther: true,
							header: "Stack",
							multiSelect: true,
							options: [
								{ description: "Local", label: "SQLite" },
								{ description: "Remote", label: "Postgres" },
							],
							question: "Which databases should we use?",
						},
					],
				},
			}),
		).toEqual([
			{
				allowOther: true,
				header: "Stack",
				id: "Which databases should we use?",
				isSecret: false,
				multiSelect: true,
				options: [
					{ description: "Local", label: "SQLite" },
					{ description: "Remote", label: "Postgres" },
				],
				question: "Which databases should we use?",
			},
		]);
	});

	it("preserves provider question IDs and secret-input policy", () => {
		expect(
			parsePendingQuestions({
				input: {
					questions: [
						{
							id: "token",
							isSecret: true,
							options: [],
							question: "Value?",
						},
					],
				},
			}),
		).toEqual([
			{
				allowOther: true,
				id: "token",
				isSecret: true,
				multiSelect: false,
				options: [],
				question: "Value?",
			},
		]);
	});

	it("builds answers with exact question text for selections and Other", () => {
		const questions = parsePendingQuestions({
			input: {
				questions: [
					{
						allowOther: true,
						multiSelect: true,
						options: [{ label: "A" }, { label: "B" }],
						question: "Pick values",
					},
					{
						allowOther: true,
						multiSelect: false,
						options: [{ label: "Known" }],
						question: "Name one",
					},
				],
			},
		});
		if (!questions) throw new Error("question fixture did not parse");

		expect(
			buildPendingQuestionAnswers(
				questions,
				{ 0: new Set([1, 0]), 1: new Set([0]) },
				{ 1: "  Custom  " },
			),
		).toEqual({ "Name one": "  Custom  ", "Pick values": "A, B" });
		expect(
			buildPendingQuestionAnswers(questions, { 0: new Set([0]) }, {}),
		).toBeUndefined();
	});

	it("preserves an exact __proto__ question key as answer data", () => {
		const questions = parsePendingQuestions({
			input: {
				questions: [{ options: [], question: "__proto__" }],
			},
		});
		if (!questions) throw new Error("question fixture did not parse");

		const answers = buildPendingQuestionAnswers(questions, {}, { 0: "safe" });
		expect(Object.entries(answers ?? {})).toEqual([["__proto__", "safe"]]);
	});

	it("keys provider answers by stable IDs even when question text repeats", () => {
		const questions = parsePendingQuestions({
			input: {
				questions: [
					{ id: "first", options: [], question: "Value?" },
					{ id: "second", options: [], question: "Value?" },
				],
			},
		});
		if (!questions) throw new Error("question fixture did not parse");

		expect(
			buildPendingQuestionAnswers(questions, {}, { 0: "A", 1: "B" }),
		).toEqual({ first: "A", second: "B" });
	});

	it("refuses malformed opaque question payloads", () => {
		expect(
			parsePendingQuestions({
				input: { questions: [{ options: [], question: "" }] },
			}),
		).toBeUndefined();
	});
});
