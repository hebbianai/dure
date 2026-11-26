import { describe, expect, it } from "vitest";
import { agentRowModel, agentRowStatus } from "@/lib/agents/agentRowModel";

describe("agentRowModel", () => {
	it("keeps only the facts it has: every agent still gets a row", () => {
		expect(agentRowModel({ agentId: "a", title: "Fix the build" })).toEqual({
			agentId: "a",
			title: "Fix the build",
			dot: { state: undefined, unread: false },
			context: [],
		});
	});

	it("orders where the agent is: project, branch, then Space", () => {
		expect(
			agentRowModel({
				agentId: "a",
				title: "t",
				spaceName: "Review",
				projectName: "repo",
			}).context,
		).toEqual(["repo", "Review"]);
		expect(
			agentRowModel({
				agentId: "a",
				title: "t",
				spaceName: "Review",
				branch: "fix/build",
				projectName: "repo",
			}).context,
		).toEqual(["repo", "fix/build", "Review"]);
		expect(
			agentRowModel({ agentId: "a", title: "t", spaceName: "Review" }).context,
		).toEqual(["Review"]);
	});

	it("shows a path and a managed summary only when a relation says so", () => {
		const row = agentRowModel({
			agentId: "a",
			title: "t",
			path: ["coordinator", "worker"],
			managed: { count: 4, needsPerson: 1, working: 2 },
		});
		expect(row.path).toEqual(["coordinator", "worker"]);
		expect(row.managed).toEqual({ count: 4, needsPerson: 1, working: 2 });
		const bare = agentRowModel({
			agentId: "a",
			title: "t",
			path: [],
			managed: { count: 0, needsPerson: 0, working: 0 },
		});
		expect("path" in bare).toBe(false);
		expect("managed" in bare).toBe(false);
	});

	it("marks a result unread on its dot", () => {
		const row = agentRowModel({
			agentId: "a",
			title: "t",
			state: "waiting",
			hasResult: true,
			sinceMs: 7,
		});
		expect(row.status).toBe("result");
		expect(row.dot).toEqual({ state: "waiting", unread: true });
		expect(row.sinceMs).toBe(7);
	});

	it("keeps a looked-at result listed without the unread ring", () => {
		const row = agentRowModel({
			agentId: "a",
			title: "t",
			state: "waiting",
			hasResult: true,
			unread: false,
		});
		expect(row.status).toBe("result");
		expect(row.dot).toEqual({ state: "waiting", unread: false });
	});

	it("says when an agent continues by itself, while nothing else lists it", () => {
		// A failed turn its backend continues after the limit resets keeps
		// its error dot and says when.
		const waiting = agentRowModel({
			agentId: "a",
			title: "t",
			state: "error",
			continuesAtMs: 9_000,
		});
		expect(waiting.continuesAtMs).toBe(9_000);
		expect(waiting.status).toBeUndefined();
		expect(waiting.dot).toEqual({ state: "error", unread: false });
		// A person answered before the reset: the agent works again.
		expect(
			agentRowModel({ agentId: "a", title: "t", state: "working", continuesAtMs: 9_000 }),
		).not.toHaveProperty("continuesAtMs");
		// A question the person must answer is still the row's reason.
		const asked = agentRowModel({
			agentId: "a",
			title: "t",
			state: "input",
			needsPerson: { reason: "input" },
			continuesAtMs: 9_000,
		});
		expect(asked.status).toBe("input");
		expect(asked).not.toHaveProperty("continuesAtMs");
	});
});

describe("agentRowStatus", () => {
	it("names why the row is listed, needs-person first", () => {
		expect(agentRowStatus({ reason: "approval" }, true)).toBe("approval");
		expect(agentRowStatus({ reason: "input" }, false)).toBe("input");
		expect(agentRowStatus({ reason: "error" }, undefined)).toBe("error");
		expect(agentRowStatus({ reason: "unexpected_exit" }, undefined)).toBe(
			"unexpected_exit",
		);
		expect(
			agentRowStatus({ reason: "unexpected_exit", signIn: true }, undefined),
		).toBe("sign_in_exit");
		expect(agentRowStatus(undefined, true)).toBe("result");
		expect(agentRowStatus(undefined, false)).toBeUndefined();
	});
});

describe("the activity line", () => {
	const base = { agentId: "a", title: "t", prompt: "Fix\n  the  build" };

	it("is what the agent was asked, on one line", () => {
		expect(agentRowModel(base).activity).toEqual({
			kind: "asked",
			text: "Fix the build",
		});
		expect("activity" in agentRowModel({ ...base, prompt: "  " })).toBe(false);
	});

	it("is the pending approval the Host projected, while one is pending", () => {
		expect(
			agentRowModel({
				...base,
				needsPerson: { reason: "approval" },
				approval: { toolName: "Bash", summary: "rm -rf build" },
			}).activity,
		).toEqual({ kind: "approval", toolName: "Bash", summary: "rm -rf build" });
		// An approval the provider did not describe falls back to the prompt.
		expect(
			agentRowModel({ ...base, needsPerson: { reason: "approval" } }).activity,
		).toEqual({ kind: "asked", text: "Fix the build" });
	});

	it("repeats a program's report only on a row the authority put there", () => {
		const programNotice = { app: "claude-code", message: "Which branch?" };
		expect(
			agentRowModel({
				...base,
				needsPerson: { reason: "input" },
				programNotice,
			}).activity,
		).toEqual({ kind: "program", app: "claude-code", message: "Which branch?" });
		expect(
			agentRowModel({ ...base, hasResult: true, programNotice }).activity,
		).toEqual({ kind: "asked", text: "Fix the build" });
		expect(
			agentRowModel({
				...base,
				needsPerson: { reason: "input" },
				programNotice: { app: "claude-code" },
			}).activity,
		).toEqual({ kind: "asked", text: "Fix the build" });
	});
});
