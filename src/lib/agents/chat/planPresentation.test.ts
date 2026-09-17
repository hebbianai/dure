import { describe, expect, it } from "vitest";
import { presentPlan } from "@/lib/agents/chat/planPresentation";

describe("presentPlan", () => {
	it("reads the codex live plan shape with step states", () => {
		expect(
			presentPlan({
				explanation: "Fix the load path",
				steps: [
					{ step: "Reproduce the failing load", status: "completed" },
					{ step: "Converge stale pins", status: "in_progress" },
					{ step: "Run scoped gates", status: "pending" },
				],
			}),
		).toEqual({
			explanation: "Fix the load path",
			steps: [
				{ text: "Reproduce the failing load", state: "done" },
				{ text: "Converge stale pins", state: "active" },
				{ text: "Run scoped gates", state: "pending" },
			],
		});
	});

	it("reads codex history plan items and todo-style payloads", () => {
		expect(
			presentPlan({
				id: "item-1",
				type: "plan",
				plan: [{ step: "One", status: "completed" }],
			}),
		).toEqual({
			explanation: null,
			steps: [{ text: "One", state: "done" }],
		});
		expect(
			presentPlan({
				todos: [
					{ content: "Ship it", status: "in_progress", activeForm: "Shipping" },
				],
			}),
		).toEqual({
			explanation: null,
			steps: [{ text: "Ship it", state: "active" }],
		});
	});

	it("accepts bare arrays of strings or step objects", () => {
		expect(presentPlan(["first", "second"])).toEqual({
			explanation: null,
			steps: [
				{ text: "first", state: "pending" },
				{ text: "second", state: "pending" },
			],
		});
	});

	it("defaults unknown statuses to pending instead of guessing", () => {
		expect(
			presentPlan({ steps: [{ step: "One", status: "deferred" }] }),
		).toEqual({ explanation: null, steps: [{ text: "One", state: "pending" }] });
	});

	it("returns null for anything it cannot represent faithfully", () => {
		expect(presentPlan(null)).toBeNull();
		expect(presentPlan("free text")).toBeNull();
		expect(presentPlan({ steps: [] })).toBeNull();
		expect(presentPlan({ steps: [{ status: "completed" }] })).toBeNull();
		expect(presentPlan({ steps: [42] })).toBeNull();
	});
});
