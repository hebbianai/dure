import { describe, expect, it } from "vitest";
import { initialAgentRuntimeBinding } from "@/lib/agents/agentLaunchCredential";
import {
	buildSidebarLayout,
	type LayoutDesktop,
	type LayoutSpace,
	UNOPENED_DESKTOP,
} from "@/lib/hub/sidebarLayout";

function desktop(id: string, name: string): LayoutDesktop {
	return { id, name };
}

function space(
	desktopId: string,
	projectName: string,
	hmuxSessionId: string | undefined,
	extra: Partial<LayoutSpace> = {},
): LayoutSpace {
	return {
		desktopId,
		projectName,
		hmuxSessionId,
		title: hmuxSessionId ?? "쉘",
		...extra,
	};
}

describe("buildSidebarLayout", () => {
	it.each(["aws", "tailscale"])(
		"publishes the first SSH agent's exact %s host before its pane exists",
		(hostId) => {
			const host = {
				id: hostId,
				name: hostId,
				host: `${hostId}.test`,
				port: 22,
				user: "qa",
				auth: "auto" as const,
			};
			const desktops = [desktop("d1", "QA")];
			expect(buildSidebarLayout(desktops, [], [], [host]).remote_hosts).toEqual(
				[],
			);
			const binding = initialAgentRuntimeBinding({
				project: {
					id: "remote-project",
					name: "Repo",
					kind: "ssh",
					sshHostId: hostId,
					path: "/srv/qa",
					isRepo: true,
				},
				sessionId: "new-remote-agent",
			});
			if (binding?.runtime !== "hmux_managed_v1" || binding.source !== "ssh")
				throw new Error("remote binding missing");
			const layout = buildSidebarLayout(
				desktops,
				[],
				[
					{
						hmuxSessionId: binding.sessionId,
						hostId: binding.hostId,
						projectName: "Repo",
						title: "New agent",
					},
				],
				[host],
			);
			expect(layout.remote_hosts).toEqual([
				expect.objectContaining({ id: hostId, host: `${hostId}.test` }),
			]);
			expect(layout.placements[binding.sessionId]).toMatchObject({
				project: "Repo",
				title: "New agent",
			});
		},
	);

	/**
	 * 브랜치는 hmux 세션 서술자에도 자리가 있지만 생산 지점 두 곳이 모두 `None`
	 * 을 넣는다 — 거기 실었으면 모든 폰에 `null` 이 갔을 것이다. 브랜치를 아는
	 * 것은 이 앱이고, 이미 데스크탑·프로젝트를 이 길로 밀어넣고 있다.
	 */
	it("브랜치를 아는 세션에만 브랜치를 싣는다", () => {
		const layout = buildSidebarLayout(
			[desktop("d1", "Workspace")],
			[
				space("d1", "agent-ide", "hmux-1", { branch: "worktree/card-tokens" }),
				space("d1", "agent-ide", "hmux-2"),
			],
		);

		expect(layout.placements["hmux-1"]).toMatchObject({
			branch: "worktree/card-tokens",
		});
		// 모르는 세션에는 키 자체가 없다. `branch: undefined` 로 두면 이 표를
		// 직전 것과 문자열로 비교하는 쪽이 흔들린다.
		expect("branch" in layout.placements["hmux-2"]).toBe(false);
	});

	it("세션을 사용자가 만든 데스크탑과 프로젝트 아래에 놓는다", () => {
		const layout = buildSidebarLayout(
			[desktop("d1", "Workspace"), desktop("d2", "Onchain")],
			[
				space("d1", "agent-ide", "hmux-1"),
				space("d1", "agent-ide", "hmux-2"),
				space("d2", "Gate1", "hmux-3"),
			],
		);

		expect(layout.placements["hmux-1"]).toEqual({
			desktop: "Workspace",
			project: "agent-ide",
			title: "hmux-1",
			order: 0,
		});
		expect(layout.placements["hmux-3"]).toEqual({
			desktop: "Onchain",
			project: "Gate1",
			title: "hmux-3",
			order: 0,
		});
	});

	/**
	 * 이름만으로는 순서를 알 수 없다. 폰이 사이드바와 같은 순서로 서려면 순서가
	 * 따로 건너가야 한다.
	 */
	it("데스크탑이 선 순서를 그대로 나른다", () => {
		const layout = buildSidebarLayout(
			[
				desktop("d1", "Workspace"),
				desktop("d2", "Onchain"),
				desktop("d3", "Artrooms"),
			],
			[],
		);
		expect(layout.desktop_order).toEqual(["Workspace", "Onchain", "Artrooms"]);
	});

	/**
	 * 이 시험이 잡는 실패가 이 파일에서 제일 중요하다.
	 *
	 * 이 앱이 pane 에 붙인 자기 id 로 키를 잡으면 표는 멀쩡히 만들어지고 폰에서는
	 * 하나도 안 맞는다 — 빈 화면만 남고 이유는 어디에도 안 나온다. 어느 값이
	 * hmux 세션 id 인지는 `paneHmuxSessionId` 한 군데가 정한다.
	 */
	it("hmux 세션 id 로 키를 잡는다", () => {
		const layout = buildSidebarLayout(
			[desktop("d1", "Workspace")],
			[space("d1", "agent-ide", "hmux-real")],
		);
		expect(Object.keys(layout.placements)).toEqual(["hmux-real"]);
	});

	/** hmux 세션이 아닌 pane 은 폰이 애초에 볼 수 없다. */
	it("hmux 세션이 아닌 pane 은 표에 넣지 않는다", () => {
		const layout = buildSidebarLayout(
			[desktop("d1", "Workspace")],
			[space("d1", "agent-ide", undefined), space("d1", "agent-ide", "hmux-1")],
		);
		expect(Object.keys(layout.placements)).toEqual(["hmux-1"]);
	});

	/**
	 * 숨긴 pane 은 원래 자리를 남기므로 같은 세션이 두 번 나올 수 있다. 사이드바가
	 * 위에서부터 그리므로 먼저 나온 자리가 사용자가 보고 있는 자리다.
	 */
	it("같은 세션이 두 자리에 있으면 먼저 나온 자리를 쓴다", () => {
		const layout = buildSidebarLayout(
			[desktop("d1", "Workspace"), desktop("d2", "Onchain")],
			[space("d1", "agent-ide", "hmux-1"), space("d2", "Gate1", "hmux-1")],
		);
		expect(layout.placements["hmux-1"].desktop).toBe("Workspace");
	});

	/** 저장소 묶음은 사이드바와 같은 함수를 쓴다 — 두 벌이면 같은 세션이 갈린다. */
	it("같은 프로젝트의 세션을 한 묶음으로 센다", () => {
		const layout = buildSidebarLayout(
			[desktop("d1", "Artrooms")],
			[
				space("d1", "artrooms-dev", "a", { projectId: "p1" }),
				space("d1", "sigbit", "b", { projectId: "p2" }),
				space("d1", "artrooms-dev", "c", { projectId: "p1" }),
			],
		);
		expect(layout.placements.a.project).toBe("artrooms-dev");
		expect(layout.placements.c.project).toBe("artrooms-dev");
		// 순서는 데스크탑 안에서 이어진다 — 묶음마다 0으로 돌아가면 폰이 두 묶음을
		// 겹쳐 세운다.
		expect(layout.placements.c.order).toBeGreaterThan(
			layout.placements.a.order,
		);
	});

	it("빈 사이드바는 빈 표다", () => {
		expect(buildSidebarLayout([], [])).toEqual({
			placements: {},
			desktop_order: [],
			remote_hosts: [],
		});
	});

	it("원격 세션의 상자 좌표는 보내되 legacy 평문 비밀번호는 보내지 않는다", () => {
		const layout = buildSidebarLayout(
			[desktop("d1", "Onchain")],
			[space("d1", "poly", "remote-1", { hostId: "gate1", title: "poly" })],
			[],
			[
				{
					id: "gate1",
					name: "Gate1",
					host: "gate1.example",
					port: 22,
					user: "me",
					auth: "password",
					secretId: "secret-ref",
					password: "never-send-this",
				},
			],
		);

		expect(layout.remote_hosts).toEqual([
			{
				id: "gate1",
				name: "Gate1",
				host: "gate1.example",
				port: 22,
				user: "me",
				auth: "password",
				secret_id: "secret-ref",
			},
		]);
		expect(JSON.stringify(layout)).not.toContain("never-send-this");
	});
});

/**
 * 사이드바 맨 아래의 "열리지 않은 에이전트"는 사용자가 보고 있는 목록의 일부다.
 * 이것만 예외로 같이 가고, 그 밖의 분류 없는 세션은 가지 않는다(2026-08-12 소유자
 * 결정).
 */
describe("buildSidebarLayout — 열리지 않은 에이전트", () => {
	it("자기 묶음으로 맨 뒤에 선다", () => {
		const layout = buildSidebarLayout(
			[desktop("d1", "Workspace")],
			[space("d1", "agent-ide", "hmux-open")],
			[{ hmuxSessionId: "hmux-idle", projectName: "agent-ide", title: "idle" }],
		);

		expect(layout.desktop_order).toEqual(["Workspace", UNOPENED_DESKTOP]);
		expect(layout.placements["hmux-idle"]).toEqual({
			desktop: UNOPENED_DESKTOP,
			project: "agent-ide",
			title: "idle",
			order: 0,
		});
	});

	/** 하나도 없으면 빈 머리글이 폰에 서면 안 된다. */
	it("하나도 없으면 묶음 자체가 생기지 않는다", () => {
		const layout = buildSidebarLayout([desktop("d1", "Workspace")], [], []);
		expect(layout.desktop_order).toEqual(["Workspace"]);
	});

	/** 아직 hmux 세션이 없는 에이전트는 폰이 볼 것이 없다. */
	it("세션이 없는 에이전트로는 묶음이 생기지 않는다", () => {
		const layout = buildSidebarLayout(
			[],
			[],
			[{ hmuxSessionId: undefined, projectName: "agent-ide", title: "idle" }],
		);
		expect(layout.desktop_order).toEqual([]);
		expect(layout.placements).toEqual({});
	});

	/**
	 * 닫는 중에는 같은 세션이 열린 pane 과 "열리지 않은" 목록에 동시에 보인다.
	 * 그때 사용자가 보고 있는 것은 열린 쪽이다.
	 */
	it("열려 있는 자리가 이긴다", () => {
		const layout = buildSidebarLayout(
			[desktop("d1", "Workspace")],
			[space("d1", "agent-ide", "hmux-1")],
			[{ hmuxSessionId: "hmux-1", projectName: "agent-ide", title: "idle" }],
		);

		expect(layout.placements["hmux-1"].desktop).toBe("Workspace");
		expect(layout.desktop_order).toEqual(["Workspace"]);
	});

	/** 준 순서 그대로다 — 여기서 다시 정렬하면 표가 몇 초마다 달라진다. */
	it("호출자가 준 순서를 그대로 쓴다", () => {
		const layout = buildSidebarLayout(
			[],
			[],
			[
				{ hmuxSessionId: "b", projectName: "agent-ide", title: "b" },
				{ hmuxSessionId: "a", projectName: "agent-ide", title: "a" },
			],
		);
		expect(layout.placements.b.order).toBe(0);
		expect(layout.placements.a.order).toBe(1);
	});
});
