import { describe, expect, it } from "vitest";
import {
	createSpacesAttentionSelector,
	createSpacesRuntimeSelector,
	type SpacesRuntimeRecords,
} from "./spacesRuntimeProjection";

function records(
	overrides: Partial<SpacesRuntimeRecords> = {},
): SpacesRuntimeRecords {
	return {
		agentActivity: {},
		sessionAgentRuntimeState: {},
		sessionCwd: {},
		sessionTitle: {},
		sessionAgent: {},
		sessionAgentPin: {},
		sessionActivity: {},
		...overrides,
	};
}

describe("Spaces runtime record projections", () => {
	it("does not read entries again for unchanged source records", () => {
		let reads = 0;
		const cwd = new Proxy(
			{ selected: "/repo", unrelated: "/noise" },
			{
				get(target, property, receiver) {
					reads += 1;
					return Reflect.get(target, property, receiver);
				},
			},
		);
		const state = records({ sessionCwd: cwd });
		const select = createSpacesRuntimeSelector(["selected"], []);
		const result = select(state);
		expect(result.sessionCwd).toEqual({ selected: "/repo" });
		expect(reads).toBe(1);
		reads = 0;
		for (let index = 0; index < 32; index += 1)
			expect(select({ ...state })).toBe(result);
		expect(reads).toBe(0);
		expect(select({ ...state, sessionTitle: { unrelated: "Noise" } })).toBe(
			result,
		);
	});

	it("keeps null and empty facts, forgets removed facts and reads a replacement scope", () => {
		const state = records({
			sessionCwd: { one: "", two: "/two" },
			sessionAgent: { one: null, two: "codex" },
			agentActivity: { agent: "working", one: "exited" },
		});
		const select = createSpacesRuntimeSelector(["one"], ["agent"]);
		const result = select(state);
		expect(result.sessionCwd).toEqual({ one: "" });
		expect(result.sessionAgent).toEqual({ one: null });
		expect(result.agentActivity).toEqual({ agent: "working" });
		const removed = select(records());
		expect(removed.sessionCwd).toEqual({});
		expect(removed.sessionAgent).toEqual({});
		expect(removed.agentActivity).toEqual({});
		expect(select(state)).toEqual(result);
		const rebound = createSpacesRuntimeSelector(["two"], [])(state);
		expect(rebound.sessionCwd).toEqual({ two: "/two" });
		expect(rebound.sessionAgent).toEqual({ two: "codex" });
	});

	it("preserves independent watcher display and unread facts across deletion", () => {
		const select = createSpacesAttentionSelector(["agent"]);
		const state = {
			displayStates: { agent: "blocked" as const },
			episodes: { agent: 3 },
			acks: { agent: 2 },
		};
		const result = select(state);
		expect(
			select({ ...state, episodes: { ...state.episodes, unrelated: 9 } }),
		).toBe(result);
		const acknowledged = select({ ...state, acks: { agent: 3 } });
		expect(acknowledged.displayStates).toBe(result.displayStates);
		expect(acknowledged.episodes).toBe(result.episodes);
		expect(acknowledged.acks).toEqual({ agent: 3 });
		expect(select({ displayStates: {}, episodes: {}, acks: {} })).toEqual({
			displayStates: {},
			episodes: {},
			acks: {},
		});
	});
});
