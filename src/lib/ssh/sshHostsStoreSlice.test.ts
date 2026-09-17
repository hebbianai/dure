import { afterEach, describe, expect, it, vi } from "vitest";
import { createSshHostsStoreSlice } from "./sshHostsStoreSlice";

/** Minimal host harness — applies updater patches the way zustand's set does
 *  and counts identity-return no-ops. */
function harness() {
	const slice = createSshHostsStoreSlice(
		(updater) => {
			const next = updater(host.state);
			if (next === host.state) {
				host.noops += 1;
				return;
			}
			host.state = { ...host.state, ...next };
		},
		() => host.state,
	);
	const host = {
		noops: 0,
		state: {
			...slice,
		} as ReturnType<typeof createSshHostsStoreSlice>,
	};
	return host;
}

describe("sshHostsStoreSlice", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});
	const draft = {
		name: "qa@192.0.2.1:22",
		host: "192.0.2.1",
		port: 22,
		user: "qa",
		auth: "auto" as const,
	};

	it("keeps one bounded-lived decision per native request and never saves a host on decline", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
		const host = harness();
		const response = host.state.requestSshRegistrationDecision(
			"one",
			draft,
			30_000,
		);
		expect(
			host.state.requestSshRegistrationDecision("one", draft, 30_000),
		).toBe(response);
		expect(host.state.sshRegistrationDecisions).toHaveLength(1);
		host.state.sshRegistrationDecisions[0].answer(false);
		await expect(response).resolves.toBe(false);
		expect(host.state.sshRegistrationDecisions).toEqual([]);
		expect(host.state.sshHosts).toEqual([]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("expires an unanswered request without dismissing another queued decision", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
		const host = harness();
		const first = host.state.requestSshRegistrationDecision(
			"one",
			draft,
			30_000,
		);
		const stale = host.state.sshRegistrationDecisions[0];
		await vi.advanceTimersByTimeAsync(1_000);
		const second = host.state.requestSshRegistrationDecision(
			"two",
			draft,
			30_000,
		);
		await vi.advanceTimersByTimeAsync(29_000);
		await expect(first).resolves.toBe(false);
		stale.answer(true);
		expect(
			host.state.sshRegistrationDecisions.map((entry) => entry.requestId),
		).toEqual(["two"]);
		host.state.sshRegistrationDecisions[0].answer(true);
		await expect(second).resolves.toBe(true);
		expect(host.state.sshHosts).toEqual([]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("rejects a delayed acceptance even when the browser timer has not fired", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const now = vi.spyOn(performance, "now").mockReturnValue(100);
		const host = harness();
		const result = host.state.requestSshRegistrationDecision(
			"one",
			draft,
			30_000,
		);
		now.mockReturnValue(30_101);
		host.state.sshRegistrationDecisions[0].answer(true);
		await expect(result).resolves.toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	});
	it("setSshState는 변화 없으면 state 자신을 반환한다 (리스너 통지 생략)", () => {
		const host = harness();
		host.state.setSshState("s1", "connecting");
		host.state.setSshState("s1", "connecting");
		expect(host.noops).toBe(1);
		expect(host.state.sshStates.s1).toBe("connecting");
	});

	it("connected 전이는 남아 있던 오류 메시지를 비운다", () => {
		const host = harness();
		host.state.setSshState("s1", "error", "auth failed");
		expect(host.state.sshMessages.s1).toBe("auth failed");
		host.state.setSshState("s1", "connected");
		expect(host.state.sshStates.s1).toBe("connected");
		expect(host.state.sshMessages.s1).toBe("");
	});
});
