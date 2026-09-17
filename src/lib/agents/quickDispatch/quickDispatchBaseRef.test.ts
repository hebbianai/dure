import { describe, expect, it, vi } from "vitest";
import { resolveQuickDispatchBaseRef } from "@/lib/agents/quickDispatch/quickDispatchBaseRef";

interface Call {
	args: string[];
	timeoutMs: number;
}

function scriptedExec(
	script: (args: string[]) => { stdout: string; code: number },
) {
	const calls: Call[] = [];
	return {
		calls,
		exec: async (args: string[], timeoutMs: number) => {
			calls.push({ args, timeoutMs });
			const out = script(args);
			return { stdout: out.stdout, stderr: "", code: out.code };
		},
	};
}

describe("resolveQuickDispatchBaseRef", () => {
	it("prefers origin/HEAD while refreshing refs with a bounded fetch", async () => {
		const { exec, calls } = scriptedExec((args) =>
			args[0] === "symbolic-ref"
				? { stdout: "origin/main\n", code: 0 }
				: { stdout: "", code: 0 },
		);
		expect(await resolveQuickDispatchBaseRef(exec)).toBe("origin/main");
		expect(calls[0].args[0]).toBe("fetch");
		expect(calls[0].timeoutMs).toBeLessThanOrEqual(8000);
	});

	it("resolves the local default ref while fetch remains pending without advancing time", async () => {
		const calls: Call[] = [];
		const exec = (args: string[], timeoutMs: number) => {
			calls.push({ args, timeoutMs });
			if (args[0] === "fetch") {
				return new Promise<{ stdout: string; stderr: string; code: number }>(
					() => {},
				);
			}
			return Promise.resolve(
				args[0] === "symbolic-ref"
					? { stdout: "origin/main\n", stderr: "", code: 0 }
					: { stdout: "", stderr: "", code: 1 },
			);
		};
		vi.useFakeTimers();
		try {
			const resolved = vi.fn();
			void resolveQuickDispatchBaseRef(exec).then(resolved);
			await vi.advanceTimersByTimeAsync(0);
			expect(resolved).toHaveBeenCalledWith("origin/main");
		} finally {
			vi.useRealTimers();
		}
		expect(calls[0].args[0]).toBe("fetch");
	});

	it("ignores fetch failure and falls through the probe order", async () => {
		const { exec, calls } = scriptedExec((args) => {
			if (args[0] === "fetch") return { stdout: "", code: -1 };
			if (args[0] === "symbolic-ref") return { stdout: "", code: 1 };
			if (args.includes("refs/remotes/origin/main"))
				return { stdout: "abc", code: 0 };
			return { stdout: "", code: 1 };
		});
		expect(await resolveQuickDispatchBaseRef(exec)).toBe("origin/main");
		for (const call of calls) {
			expect(call.timeoutMs).toBeLessThanOrEqual(8000);
			if (call.args[0] !== "fetch") {
				expect(call.timeoutMs).toBeLessThanOrEqual(3000);
			}
		}
	});

	it("probes remote refs before local refs, in the pinned order", async () => {
		const { exec, calls } = scriptedExec((args) =>
			args.includes("refs/heads/main")
				? { stdout: "abc", code: 0 }
				: { stdout: "", code: 1 },
		);
		expect(await resolveQuickDispatchBaseRef(exec)).toBe("main");
		const probeRefs = calls
			.filter((call) => call.args[0] === "rev-parse")
			.map((call) => call.args[call.args.length - 1]);
		expect(probeRefs).toEqual([
			"refs/remotes/origin/main",
			"refs/remotes/origin/master",
			"refs/heads/main",
		]);
	});

	it("falls back to local main when only a local branch exists", async () => {
		const { exec } = scriptedExec((args) =>
			args.includes("refs/heads/main")
				? { stdout: "abc", code: 0 }
				: { stdout: "", code: 1 },
		);
		expect(await resolveQuickDispatchBaseRef(exec)).toBe("main");
	});

	it("falls back to master when nothing else resolves", async () => {
		const { exec } = scriptedExec((args) =>
			args.includes("refs/heads/master")
				? { stdout: "abc", code: 0 }
				: { stdout: "", code: 1 },
		);
		expect(await resolveQuickDispatchBaseRef(exec)).toBe("master");
	});

	it("falls back to HEAD when every probe fails", async () => {
		const { exec } = scriptedExec(() => ({ stdout: "", code: 1 }));
		expect(await resolveQuickDispatchBaseRef(exec)).toBe("HEAD");
	});

	it("never rejects when the exec function itself throws", async () => {
		const exec = async (): Promise<never> => {
			throw new Error("boom");
		};
		expect(await resolveQuickDispatchBaseRef(exec)).toBe("HEAD");
	});
});
