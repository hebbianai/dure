import { describe, expect, it } from "vitest";
import { paneHmuxSessionId } from "@/lib/spaces/hmuxSessionIdentity";

describe("paneHmuxSessionId", () => {
	it("터미널 pane 은 자기 hmuxIdentity 를 쓴다", () => {
		expect(
			paneHmuxSessionId({ kind: "term", hmuxIdentity: { sessionId: "hmux-1" } }),
		).toBe("hmux-1");
	});

	/**
	 * 이 시험이 이 파일에서 제일 중요하다.
	 *
	 * 에이전트 pane 은 세션 신원을 자기 안에 들고 있지 않다. 이 갈래를 빼먹으면
	 * 사이드바에서 제일 많은 줄이 통째로 빠지고, 타입은 통과하고, 폰에는
	 * 아무것도 안 뜬다 — 실제로 그렇게 한 세대를 보냈다.
	 */
	it("에이전트 pane 은 에이전트 레코드의 binding 을 쓴다", () => {
		expect(
			paneHmuxSessionId(
				{ kind: "agent" },
				{ runtimeBinding: { runtime: "hmux_managed_v1", sessionId: "hmux-2" } },
			),
		).toBe("hmux-2");
	});

	/**
	 * legacy 레코드의 `sessionId` 는 hmux 가 모르는 값이다. 실어 보내면 폰은
	 * 있지도 않은 세션의 자리를 들고 있게 된다.
	 */
	it("hmux 이전 레코드의 세션 id 를 hmux 세션으로 내보내지 않는다", () => {
		expect(
			paneHmuxSessionId(
				{ kind: "agent" },
				{ runtimeBinding: { runtime: "legacy_session_v1", sessionId: "pty-1" } },
			),
		).toBeUndefined();
	});

	it("아직 세션이 없는 에이전트는 id 가 없다", () => {
		expect(paneHmuxSessionId({ kind: "agent" }, {})).toBeUndefined();
		expect(paneHmuxSessionId({ kind: "agent" })).toBeUndefined();
	});

	it("hmux 세션이 아닌 터미널 pane 은 id 가 없다", () => {
		expect(paneHmuxSessionId({ kind: "term" })).toBeUndefined();
	});

	/**
	 * 에이전트 pane 에 pane 쪽 신원이 실려 오더라도 그것을 쓰지 않는다. 에이전트의
	 * 진실은 레코드 쪽이고, 두 곳을 다 보면 어느 쪽이 이기는지가 호출자마다
	 * 달라진다.
	 */
	it("에이전트 pane 은 레코드 쪽만 본다", () => {
		expect(
			paneHmuxSessionId({ kind: "agent", hmuxIdentity: { sessionId: "pane-1" } }, {}),
		).toBeUndefined();
	});
});
