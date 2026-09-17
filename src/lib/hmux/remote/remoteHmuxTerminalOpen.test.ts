import { describe, expect, it } from "vitest";
import type { RemoteHmuxCatalogTargetV1 } from "@/lib/hmux/remote/remoteHmuxBroker";
import {
	planRemoteHmuxTerminalOpen,
	REMOTE_HMUX_INITIAL_COLUMNS,
	REMOTE_HMUX_INITIAL_ROWS,
	type RemoteHmuxOpenIds,
} from "@/lib/hmux/remote/remoteHmuxTerminalOpen";

const IDS: RemoteHmuxOpenIds = {
	sessionSuffix: "s1",
	requestSuffix: "r1",
	launchProofSuffix: "p1",
	bridgeSuffix: "b1",
};

const TARGET = { hostId: "host-1" } as unknown as RemoteHmuxCatalogTargetV1;

describe("planRemoteHmuxTerminalOpen", () => {
	it("keeps the native session identity in its create request", () => {
		const plan = planRemoteHmuxTerminalOpen({ target: TARGET, ids: IDS });
		expect(plan.targetSessionId).toBe("standalone_s1");
		expect(plan.create.targetSessionId).toBe(plan.targetSessionId);
	});

	it("leaves pane identity to the presentation owner", () => {
		const plan = planRemoteHmuxTerminalOpen({ target: TARGET, ids: IDS });
		expect(plan).not.toHaveProperty("panelId");
	});

	/**
	 * 호스트 이름은 사용자가 지은 것이라 공백도 한글도 들어온다. 원격 프로토콜은
	 * 제한된 식별자만 받으므로 이름은 우리가 만든 id 에 묶는다.
	 */
	it("세션 이름을 사용자 문자열이 아니라 우리 id 로 짓는다", () => {
		const plan = planRemoteHmuxTerminalOpen({ target: TARGET, ids: IDS });
		expect(plan.create.sessionName).toBe("remote-standalone_s1");
	});

	/** 요청·증명·다리는 서로 다른 값이어야 한다 — 하나가 새면 나머지도 샌다. */
	it("요청 id, 실행 증명, 다리 난스를 따로 만든다", () => {
		const plan = planRemoteHmuxTerminalOpen({ target: TARGET, ids: IDS });
		const values = [
			plan.create.requestId,
			plan.create.launchOwnerProof,
			plan.create.bridgeNonce,
		];
		expect(new Set(values).size).toBe(3);
	});

	/**
	 * 두 입구(버튼과 터미널에서 친 ssh)가 다른 목록을 들고 있으면, 같은 서버에서
	 * 같은 명령이 어떤 날은 관리형으로 승격되고 어떤 날은 안 된다.
	 */
	it("명령 가로채기 목록이 핸드오프 쪽과 같다", () => {
		const plan = planRemoteHmuxTerminalOpen({ target: TARGET, ids: IDS });
		expect(plan.create.commandIntercepts).toEqual([
			{ command: "claude", providerId: "claude" },
			{ command: "codex", providerId: "codex" },
		]);
	});

	/** 첫 크기가 0/1 이면 붙기 전 첫 화면이 접힌 채로 그려진다. */
	it("첫 크기를 로컬 생성과 같은 값으로 둔다", () => {
		const plan = planRemoteHmuxTerminalOpen({ target: TARGET, ids: IDS });
		expect(plan.create.initialColumns).toBe(REMOTE_HMUX_INITIAL_COLUMNS);
		expect(plan.create.initialRows).toBe(REMOTE_HMUX_INITIAL_ROWS);
		expect(plan.create.initialRows).toBeGreaterThan(1);
	});

	it("실제 크기를 알면 그것을 쓴다", () => {
		const plan = planRemoteHmuxTerminalOpen({
			target: TARGET,
			ids: IDS,
			columns: 80,
			rows: 24,
		});
		expect(plan.create.initialColumns).toBe(80);
		expect(plan.create.initialRows).toBe(24);
	});

	it("carries the split remote cwd in the Host creation contract", () => {
		const plan = planRemoteHmuxTerminalOpen({
			target: TARGET,
			ids: IDS,
			cwd: "/home/gate1/projects/quant/gate_hft",
		});
		expect(plan.create.cwd).toBe("/home/gate1/projects/quant/gate_hft");
	});

	it("고른 대상을 그대로 싣는다", () => {
		const plan = planRemoteHmuxTerminalOpen({ target: TARGET, ids: IDS });
		expect(plan.create.target).toBe(TARGET);
	});
});
