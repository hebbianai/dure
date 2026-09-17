import { describe, expect, it, vi } from "vitest";
import {
	type AgentFileDiff,
	type HubFileDiffDeps,
	type HubFileDiffReply,
	type RemoteFileDiff,
	answerHubFileDiff,
} from "./fileDiffBridge";

const DISPATCH = { request_id: "file-diff-0", session_id: "s1", path: "src/app.ts" };

function deps(over: Partial<HubFileDiffDeps> = {}): {
	deps: HubFileDiffDeps;
	replies: HubFileDiffReply[];
} {
	const replies: HubFileDiffReply[] = [];
	return {
		replies,
		deps: {
			locate: () => ({ kind: "local", worktreePath: "/w" }),
			fileDiff: async (): Promise<AgentFileDiff> => ({
				path: "src/app.ts",
				patch: "@@ -1 +1 @@\n+a\n",
				added: 1,
				deleted: 0,
			}),
			remoteFileDiff: async (): Promise<RemoteFileDiff> => {
				throw new Error("not reachable in this test");
			},
			report: async (_id, reply) => {
				replies.push(reply);
				return true;
			},
			...over,
		},
	};
}

describe("answerHubFileDiff", () => {
	it("answers with the patch and echoes the path that was asked for", async () => {
		const { deps: d, replies } = deps();

		await answerHubFileDiff(DISPATCH, d);

		expect(replies).toEqual([
			{ path: "src/app.ts", patch: "@@ -1 +1 @@\n+a\n", added: 1, deleted: 0 },
		]);
	});

	/**
	 * A binary file is a fact, not an empty patch. Reporting `patch: ""` would
	 * draw a PNG as "nothing in this file changed".
	 */
	it("reports a binary file as binary rather than as an empty body", async () => {
		const { deps: d, replies } = deps({
			fileDiff: async () => ({ path: "logo.png", patch: null, added: null, deleted: null }),
		});

		await answerHubFileDiff({ ...DISPATCH, path: "logo.png" }, d);

		expect(replies).toEqual([{ path: "logo.png", binary: true }]);
	});

	/**
	 * The reader's own sentence survives. "no such path in this comparison" and
	 * "not a repository" send somebody to different places, and only the reader
	 * knows which one it was.
	 */
	it("carries the reader's reason instead of throwing", async () => {
		const { deps: d, replies } = deps({
			fileDiff: async () => {
				throw new Error("이 비교에 그 경로가 없습니다");
			},
		});

		await answerHubFileDiff(DISPATCH, d);

		expect(replies).toEqual([{ path: "src/app.ts", detail: "이 비교에 그 경로가 없습니다" }]);
	});

	/**
	 * The phone falls back to its own SSH connection on `session_elsewhere`, and
	 * this window can fail where the phone succeeds — the box may be absent from
	 * *this* machine's `known_hosts`. Minting any other code closes that road.
	 */
	it("keeps every local failure of a remote session as session_elsewhere", async () => {
		for (const location of [
			{ kind: "remote" as const },
			{ kind: "remote" as const, boxId: "box-1" },
			{ kind: "remote" as const, boxId: "box-1", workspaceId: "w1" },
		]) {
			const { deps: d, replies } = deps({
				locate: () => location,
				remoteFileDiff: async () => {
					throw new Error("no_remote_host:box-1");
				},
			});

			await answerHubFileDiff(DISPATCH, d);

			expect(replies[0]?.code).toBe("session_elsewhere");
		}
	});

	/**
	 * The box answered, and said why. That is not the phone's cue to ask the box
	 * itself — it just did, through us.
	 */
	it("does not send the phone back to a box that already refused", async () => {
		const { deps: d, replies } = deps({
			locate: () => ({ kind: "remote", boxId: "box-1", workspaceId: "w1" }),
			remoteFileDiff: async () => ({
				kind: "unavailable",
				reason: "path_not_listed",
				path: "src/app.ts",
				patch: null,
				truncated: false,
				added: null,
				deleted: null,
			}),
		});

		await answerHubFileDiff(DISPATCH, d);

		expect(replies[0]?.code).toBe("remote_path_not_listed");
		expect(replies[0]?.code).not.toBe("session_elsewhere");
	});

	/**
	 * The laptop's own ceiling is larger than a box's, so a body the box already
	 * cut is comfortably under it and would be re-encoded as whole. Dropping the
	 * flag here makes the phone draw a truncated file as the end of the file.
	 */
	it("keeps a box's truncation flag rather than re-encoding the body as whole", async () => {
		const { deps: d, replies } = deps({
			locate: () => ({ kind: "remote", boxId: "box-1", workspaceId: "w1" }),
			remoteFileDiff: async () => ({
				kind: "read",
				reason: null,
				path: "src/app.ts",
				patch: "@@ -1 +1 @@\n+a\n",
				truncated: true,
				added: 1,
				deleted: 0,
			}),
		});

		await answerHubFileDiff(DISPATCH, d);

		expect(replies[0]?.truncated).toBe(true);
	});

	it("passes the commit through so a commit's file opens that commit's patch", async () => {
		const fileDiff = vi.fn(async () => ({
			path: "src/app.ts",
			patch: "@@ -1 +1 @@\n+a\n",
			added: 1,
			deleted: 0,
		}));
		const { deps: d } = deps({ fileDiff });

		await answerHubFileDiff({ ...DISPATCH, commit: "46d1088" }, d);

		// Dropping it would show the worktree's version of a file somebody opened
		// from a commit — a screen that looks right and is about another moment.
		expect(fileDiff).toHaveBeenCalledWith("/w", "src/app.ts", "46d1088");
	});

	it("says this window does not know the session rather than answering for it", async () => {
		const { deps: d, replies } = deps({ locate: () => undefined });

		await answerHubFileDiff(DISPATCH, d);

		expect(replies[0]?.detail).toBeDefined();
		expect(replies[0]?.patch).toBeUndefined();
	});
});
