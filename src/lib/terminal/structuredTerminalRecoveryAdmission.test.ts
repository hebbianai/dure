import { describe, expect, it, vi } from "vitest";
import type { TerminalPresentationRole } from "./presentation/terminalPresentationRoleStore";
import { StructuredTerminalRecoveryAdmission } from "./structuredTerminalRecoveryAdmission";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

describe("StructuredTerminalRecoveryAdmission", () => {
	it("admits a selected pane before an earlier hovered pane", async () => {
		const admission = new StructuredTerminalRecoveryAdmission(1);
		const gate = deferred();
		const starts: TerminalPresentationRole[] = [];
		const active = admission.run({
			signal: new AbortController().signal,
			readRole: () => "background",
			operation: () => gate.promise,
		});
		const roles: TerminalPresentationRole[] = [
			"background",
			"hovered",
			"foreground",
			"ungated",
		];
		const pending = roles.map((role) =>
			admission.run({
				signal: new AbortController().signal,
				readRole: () => role,
				operation: () => {
					starts.push(role);
				},
			}),
		);
		gate.resolve();
		await Promise.all([active, ...pending]);
		expect(starts).toEqual(["foreground", "hovered", "ungated", "background"]);
	});

	it("bounds recovery attach phases and admits a queued foreground first", async () => {
		const admission = new StructuredTerminalRecoveryAdmission(2);
		const starts: string[] = [];
		const firstGate = deferred();
		const secondGate = deferred();
		const backgroundGate = deferred();
		const foregroundGate = deferred();
		const run = (
			name: string,
			readRole: () => "foreground" | "background",
			gate: ReturnType<typeof deferred>,
		) =>
			admission.run({
				signal: new AbortController().signal,
				readRole,
				operation: () => {
					starts.push(name);
					return gate.promise;
				},
			});

		let promotedRole: "foreground" | "background" = "background";
		const first = run("first", () => "background", firstGate);
		const second = run("second", () => "background", secondGate);
		const background = run(
			"queued-background",
			() => "background",
			backgroundGate,
		);
		const foreground = run(
			"queued-foreground",
			() => promotedRole,
			foregroundGate,
		);
		expect(starts).toEqual(["first", "second"]);

		promotedRole = "foreground";
		firstGate.resolve();
		await first;
		expect(starts).toEqual(["first", "second", "queued-foreground"]);

		secondGate.resolve();
		foregroundGate.resolve();
		backgroundGate.resolve();
		await Promise.all([second, background, foreground]);
		expect(starts).toEqual([
			"first",
			"second",
			"queued-foreground",
			"queued-background",
		]);
	});

	it("removes an aborted queued pane without starting its attach", async () => {
		const admission = new StructuredTerminalRecoveryAdmission(1);
		const activeGate = deferred();
		const queuedAbort = new AbortController();
		const queuedOperation = vi.fn();
		const active = admission.run({
			signal: new AbortController().signal,
			readRole: () => "background" as const,
			operation: () => activeGate.promise,
		});
		const queued = admission.run({
			signal: queuedAbort.signal,
			readRole: () => "foreground" as const,
			operation: queuedOperation,
		});

		queuedAbort.abort();
		await expect(queued).rejects.toMatchObject({ name: "AbortError" });
		activeGate.resolve();
		await active;
		expect(queuedOperation).not.toHaveBeenCalled();
	});

	it("releases a slot when a recovery attach phase fails", async () => {
		const admission = new StructuredTerminalRecoveryAdmission(1);
		const nextOperation = vi.fn(() => "attached");
		const failed = admission.run({
			signal: new AbortController().signal,
			readRole: () => "background" as const,
			operation: () => Promise.reject(new Error("attach failed")),
		});
		const next = admission.run({
			signal: new AbortController().signal,
			readRole: () => "background" as const,
			operation: nextOperation,
		});

		await expect(failed).rejects.toThrow("attach failed");
		await expect(next).resolves.toBe("attached");
		expect(nextOperation).toHaveBeenCalledOnce();
	});
});
