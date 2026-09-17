import { describe, expect, it } from "vitest";
import type { GitStatus } from "@/types";
import { createScmReviewStoreSlice } from "./scmReviewStoreSlice";

/** Minimal host harness — applies updater patches the way zustand's set does
 *  and counts identity-return no-ops, which the slice uses to skip listener
 *  notification on unchanged polling writes. */
function harness() {
	const slice = createScmReviewStoreSlice((updater) => {
		const next = updater(host.state);
		if (next === host.state) {
			host.noops += 1;
			return;
		}
		host.state = { ...host.state, ...next };
	});
	const host = { noops: 0, state: slice };
	return host;
}

const gitStatus = (overrides: Partial<GitStatus> = {}): GitStatus => ({
	isRepo: true,
	branch: "main",
	ahead: 0,
	behind: 0,
	staged: 0,
	unstaged: 0,
	untracked: 0,
	...overrides,
});

describe("scmReviewStoreSlice", () => {
	it("변화 없는 git 폴링 결과는 state 자신을 반환한다 (리스너 통지 생략)", () => {
		const host = harness();
		host.state.setGitStatus("a1", gitStatus());
		const before = host.state.gitStatuses;
		host.state.setGitStatus("a1", gitStatus());
		expect(host.noops).toBe(1);
		expect(host.state.gitStatuses).toBe(before);
	});

	it("성공한 폴링은 이전 오류 기록을 함께 지운다", () => {
		const host = harness();
		host.state.setGitStatusError("a1", "  boom  ");
		expect(host.state.gitStatusErrors.a1).toBe("boom");
		host.state.setGitStatus("a1", gitStatus());
		expect("a1" in host.state.gitStatusErrors).toBe(false);
		// 같은 오류 문자열 재기록은 no-op.
		host.state.setGitStatusError("a1", "x");
		host.state.setGitStatusError("a1", "x");
		expect(host.noops).toBe(1);
	});

	it("addDiffComment는 생성된 코멘트를 돌려주고 에이전트별로 쌓는다", () => {
		const host = harness();
		const created = host.state.addDiffComment({
			agentId: "a1",
			filePath: "src/a.ts",
			line: 3,
			body: "rename this",
			now: 1000,
		});
		expect(created.agentId).toBe("a1");
		expect(host.state.diffComments.a1).toEqual([created]);
	});

	it("코멘트 수정은 sent 표시를 지우고, 스냅샷 일치분만 sentAt를 받는다", () => {
		const host = harness();
		const c = host.state.addDiffComment({
			agentId: "a1",
			filePath: "src/a.ts",
			line: 0,
			body: "v1",
			now: 1000,
		});
		host.state.markDiffCommentsSent("a1", [{ id: c.id, body: "v1" }], 2000);
		expect(host.state.diffComments.a1[0].sentAt).toBe(2000);
		host.state.updateDiffComment("a1", c.id, "v2");
		expect(host.state.diffComments.a1[0].sentAt).toBeUndefined();
		// 전송 중 수정된 코멘트는 스냅샷과 달라 미전송으로 남는다.
		host.state.markDiffCommentsSent("a1", [{ id: c.id, body: "v1" }], 3000);
		expect(host.state.diffComments.a1[0].sentAt).toBeUndefined();
	});

	it("코멘트 목록이 없는 에이전트에 대한 수정·삭제·전송 표시는 아무것도 만들지 않는다", () => {
		const host = harness();
		host.state.updateDiffComment("ghost", "c1", "body");
		host.state.removeDiffComment("ghost", "c1");
		host.state.markDiffCommentsSent("ghost", [], 1000);
		expect(host.state.diffComments).toEqual({});
	});
});
