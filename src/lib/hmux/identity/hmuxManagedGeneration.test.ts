import { describe, expect, it } from "vitest";
import {
	HMUX_MANAGED_GENERATION_FIELDS,
	parseHmuxManagedGenerationV1,
	sameExactHmuxManagedSession,
	sameHmuxManagedGeneration,
} from "@/lib/hmux/identity/hmuxManagedGeneration";

const generation = {
	runnerPrincipal: "principal-1",
	runnerInstance: "runner-1",
	channelEpoch: "7",
	hostInstanceId: "host-1",
	terminalEpoch: "terminal-1",
};

describe("exact Hmux managed generation identity", () => {
	it.each(HMUX_MANAGED_GENERATION_FIELDS)(
		"includes %s in equality",
		(field) => {
			expect(
				sameHmuxManagedGeneration(generation, {
					...generation,
					[field]: `${generation[field]}-changed`,
				}),
			).toBe(false);
		},
	);

	it("defines missing-generation equality explicitly", () => {
		expect(sameHmuxManagedGeneration(undefined, undefined)).toBe(true);
		expect(sameHmuxManagedGeneration(generation, undefined)).toBe(false);
		expect(sameHmuxManagedGeneration(undefined, generation)).toBe(false);
		expect(sameExactHmuxManagedSession(undefined, undefined)).toBe(true);
	});

	it("parses one canonical complete generation", () => {
		expect(parseHmuxManagedGenerationV1(generation)).toEqual(generation);
		expect(
			parseHmuxManagedGenerationV1({ ...generation, channelEpoch: "0" }),
		).toBeUndefined();
		expect(
			parseHmuxManagedGenerationV1({
				...generation,
				channelEpoch: "not-decimal",
			}),
		).toBeUndefined();
		expect(
			parseHmuxManagedGenerationV1({ ...generation, futureField: "unknown" }),
		).toEqual(generation);
	});

	it.each(["sessionId", "workspaceId", "providerId"] as const)(
		"composes %s over generation equality",
		(field) => {
			const session = {
				sessionId: "session-1",
				workspaceId: "workspace-1",
				providerId: "codex",
				...generation,
			};
			expect(
				sameExactHmuxManagedSession(session, {
					...session,
					[field]: `${session[field]}-changed`,
				}),
			).toBe(false);
		},
	);
});
