import { describe, expect, it } from "vitest";
import {
	parseProgramStatus,
	programStatusNotice,
	waitingProgramStatusNotice,
} from "./programStatus";

describe("parseProgramStatus", () => {
	it("keeps every field of a consistent report", () => {
		expect(
			parseProgramStatus({
				state: "blocked",
				blocked_kind: "question",
				app: "claude-code",
				message: "Which branch? 브랜치를 골라 주세요",
			}),
		).toEqual({
			state: "blocked",
			blocked_kind: "question",
			app: "claude-code",
			message: "Which branch? 브랜치를 골라 주세요",
		});
		expect(parseProgramStatus({ state: "idle" })).toEqual({ state: "idle" });
	});

	it("treats anything inconsistent or undisplayable as absent", () => {
		for (const value of [
			undefined,
			null,
			[],
			"working",
			{ state: "paused" },
			{ state: "working", blocked_kind: "question" },
			{ state: "blocked", blocked_kind: "approval" },
			{ state: "done", blocked_kind: "auth" },
			{ state: "idle", app: "has space" },
			{ state: "idle", app: "x".repeat(33) },
			{ state: "idle", message: "" },
			{ state: "idle", message: "two\nlines" },
			{ state: "idle", message: "c1\u0085" },
			{ state: "idle", message: "é".repeat(1025) },
		]) {
			expect(parseProgramStatus(value), JSON.stringify(value)).toBeUndefined();
		}
	});
});

describe("programStatusNotice", () => {
	it("stays quiet while the program runs, waits or finishes", () => {
		for (const state of ["idle", "working", "done"] as const) {
			expect(programStatusNotice({ state, message: "busy" })).toBeUndefined();
		}
		expect(programStatusNotice(undefined)).toBeUndefined();
	});

	it("names what a blocked or failed program needs", () => {
		expect(
			programStatusNotice({
				state: "blocked",
				blocked_kind: "auth",
				app: "gh",
			}),
		).toEqual({ kind: "auth", app: "gh" });
		expect(programStatusNotice({ state: "blocked" })).toEqual({
			kind: "blocked",
		});
		expect(
			programStatusNotice({ state: "error", message: "Build failed" }),
		).toEqual({ kind: "error", message: "Build failed" });
	});

	it("removes formatting characters that could reorder or hide header text", () => {
		expect(
			programStatusNotice({
				state: "error",
				message: "‮evil​ name",
			}),
		).toEqual({ kind: "error", message: "evil name" });
		expect(
			programStatusNotice({ state: "error", message: "⁦" }),
		).toEqual({ kind: "error" });
	});
});

describe("waitingProgramStatusNotice", () => {
	const running = (
		programStatus: Parameters<typeof programStatusNotice>[0],
	) => ({ lifecycle: "running" as const, programStatus });

	it.each(["permission", "question", "auth"] as const)(
		"repeats a program waiting for %s with its author",
		(kind) => {
			expect(
				waitingProgramStatusNotice(
					running({
						state: "blocked",
						blocked_kind: kind,
						app: "codex",
						message: "Run tests?",
					}),
					true,
				),
			).toEqual({ kind, app: "codex", message: "Run tests?" });
		},
	);

	it("repeats a wait the program did not classify", () => {
		expect(
			waitingProgramStatusNotice(running({ state: "blocked" }), true),
		).toEqual({ kind: "blocked" });
	});

	it("leaves a failure on the pane because it is a result, not a wait", () => {
		expect(
			waitingProgramStatusNotice(running({ state: "error" }), true),
		).toBeUndefined();
	});

	it("says nothing while the program is working or has stopped reporting", () => {
		expect(
			waitingProgramStatusNotice(running({ state: "working" }), true),
		).toBeUndefined();
		expect(waitingProgramStatusNotice(running(undefined), true)).toBeUndefined();
		expect(waitingProgramStatusNotice(undefined, true)).toBeUndefined();
	});

	it("makes no claim for an exited agent or a snapshot no live stream supports", () => {
		const blocked = { state: "blocked" as const, blocked_kind: "permission" as const };
		expect(
			waitingProgramStatusNotice(
				{ lifecycle: "exited", programStatus: blocked },
				true,
			),
		).toBeUndefined();
		expect(waitingProgramStatusNotice(running(blocked), false)).toBeUndefined();
	});

	it("accepts a snapshot from before any stream lifetime existed", () => {
		expect(
			waitingProgramStatusNotice(
				running({ state: "blocked", blocked_kind: "auth" }),
				undefined,
			),
		).toEqual({ kind: "auth" });
	});
});
