// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PluginPermissionPlanReview } from "@/components/plugins/PluginPermissionPlanReview";
import type { DurePluginPermissionSnapshot } from "@/lib/ipc/plugins";

type ReviewStatus =
	DurePluginPermissionSnapshot["review"]["comparison"]["status"];

function permissionSnapshot(
	status: ReviewStatus = "changed_since_review",
): DurePluginPermissionSnapshot {
	const currentDigest = `sha256:${"d".repeat(64)}`;
	const reviewedDigest = `sha256:${"e".repeat(64)}`;
	const projectionDigest = `sha256:${"f".repeat(64)}`;
	const comparison: DurePluginPermissionSnapshot["review"]["comparison"] =
		status === "no_reviewed_plan"
			? { status }
			: status === "matches_reviewed_projection"
				? { status, reviewed_plan_digest: currentDigest }
				: status === "legacy_digest_only"
					? { status, reviewed_plan_digest: reviewedDigest }
					: {
							status,
							reviewed_plan_digest: reviewedDigest,
							diff: {
								changes: [],
								catalog_snapshot_fingerprint_only: false,
							},
						};
	return {
		plan: {
			schema_version: 2,
			identity: {
				plugin_id: "dure.beads",
				publisher: "dure",
				version: "0.2.0",
			},
			authority: {
				authority: "dure.release",
				catalog_snapshot_sha256: `sha256:${"a".repeat(64)}`,
			},
			workspace_identity: `sha256:${"b".repeat(64)}`,
			catalog_selection: {
				source_id: "dure.bundled",
				candidate_id: "dure.beads.bundled",
			},
			applied_policy_digest: `sha256:${"c".repeat(64)}`,
			negotiated_host_api_version: 2,
			activation: [
				{ kind: "explicit" },
				{ kind: "workspace_contains", pattern: ".beads" },
			],
			contributions: [
				{
					id: "dure.beads.issue-tracker",
					family: "dure.issue-tracker",
					family_api_version: 1,
					required: true,
					placement: "workspace",
					resource: "./contributions/issue-tracker.json",
				},
			],
			ignored_optional_contributions: ["dure.beads.future-view"],
			agent_integrations: [
				{
					id: "dure.beads.codex",
					adapter: "codex",
					required: false,
					resource: "./agents/codex",
					selector: {
						plugin: "dure-beads",
						marketplace: "dure-bundled",
					},
				},
			],
			ignored_optional_agent_integrations: ["dure.beads.claude"],
			permissions: [
				{
					kind: "dure.issue-tracker.read",
					parameters: { operations: ["activate", "watch"] },
				},
			],
			digest: currentDigest,
		},
		review: {
			current: {
				schema_version: 2,
				plan_digest: currentDigest,
				projection_digest: projectionDigest,
				entries: [
					{
						subject: "permission",
						field: "required",
						key_segments: ["dure.issue-tracker.read", "operations"],
						value: { kind: "boolean", value: true },
					},
					{
						subject: "permission",
						field: "granted_values",
						key_segments: ["dure.issue-tracker.read", "operations"],
						value: {
							kind: "string_list",
							values: ["activate", "watch"],
						},
					},
					{
						subject: "catalog_resource",
						field: "content_sha256",
						key_segments: ["./contributions/issue-tracker.json"],
						value: { kind: "string", value: `sha256:${"9".repeat(64)}` },
					},
				],
			},
			comparison,
		},
		record_revision: "4",
		decision_revision: "2",
		enablement_epoch: "4",
		decision: "approve",
		reviewed_plan_digest:
			status === "no_reviewed_plan"
				? null
				: status === "matches_reviewed_projection"
					? currentDigest
					: reviewedDigest,
		plan_comparison:
			status === "no_reviewed_plan"
				? "no_reviewed_plan"
				: status === "matches_reviewed_projection"
					? "matches_reviewed_plan"
					: "changed_since_review",
		enabled: false,
	};
}

afterEach(cleanup);

function expectTechnicalField(label: string, value: string) {
	const field = screen.getByText(label).parentElement;
	expect(field?.textContent).toContain(value);
}

describe("PluginPermissionPlanReview", () => {
	it("shows every current canonical-plan field without implying native installation", () => {
		render(
			<PluginPermissionPlanReview
				permission={permissionSnapshot()}
				workspaceRoot="/work/repository"
			/>,
		);

		const details = screen.getByText("승인 범위 전체 보기").closest("details");
		expect(details?.open).toBe(true);
		expectTechnicalField("플러그인 ID", "dure.beads");
		expectTechnicalField("표시 게시자(신뢰 주체 아님)", "dure");
		expectTechnicalField("플러그인 버전", "0.2.0");
		expectTechnicalField(
			"요청 화면 Workspace 경로(승인 식별자 아님)",
			'"/work/repository"',
		);
		expectTechnicalField("Workspace 식별 지문", `sha256:${"b".repeat(64)}`);
		expect(
			screen.getAllByText("dure.issue-tracker.read").length,
		).toBeGreaterThan(0);
		expect(screen.getByText("operations")).toBeTruthy();
		expect(screen.getAllByText('["activate","watch"]').length).toBeGreaterThan(
			0,
		);
		expect(screen.getByText("명시적으로 켤 때")).toBeTruthy();
		expect(
			screen.getByText('Workspace에 ".beads" 항목이 있을 때'),
		).toBeTruthy();
		expect(screen.getByText("dure.beads.issue-tracker")).toBeTruthy();
		expect(
			screen.getByText(/dure\.issue-tracker API 1 · 필수 · 배치: workspace/),
		).toBeTruthy();
		expect(
			screen.getAllByText('"./contributions/issue-tracker.json"').length,
		).toBeGreaterThan(0);
		expect(screen.getByText("dure.beads.codex")).toBeTruthy();
		expect(screen.getByText(/codex · 선택/)).toBeTruthy();
		expectTechnicalField("에이전트 플러그인 ID", "dure-beads");
		expectTechnicalField("에이전트 마켓플레이스 ID", "dure-bundled");
		expect(screen.getByText('"./agents/codex"')).toBeTruthy();
		expect(screen.getByText('["dure.beads.future-view"]')).toBeTruthy();
		expect(screen.getByText('["dure.beads.claude"]')).toBeTruthy();
		expectTechnicalField(
			"호스트 지정 내장 권위 ID(게시자·서명자 아님)",
			"dure.release",
		);
		expectTechnicalField("발견 소스 ID(신뢰 주체 아님)", "dure.bundled");
		expectTechnicalField(
			"카탈로그 후보 ID(신뢰 주체 아님)",
			"dure.beads.bundled",
		);
		expectTechnicalField(
			"선언 카탈로그 스냅샷 지문(네이티브 설치 트리 제외)",
			`sha256:${"a".repeat(64)}`,
		);
		expectTechnicalField("권한 정책 지문", `sha256:${"c".repeat(64)}`);
		expectTechnicalField("협상된 호스트 API", "2");
		expectTechnicalField("플랜 스키마", "2");
		expectTechnicalField("현재 플랜 지문", `sha256:${"d".repeat(64)}`);
		expectTechnicalField("이전 검토 지문", `sha256:${"e".repeat(64)}`);
		expect(screen.getByText("검토 후 변경")).toBeTruthy();
		expect(
			screen.queryByText(
				"이전 검토 내용은 저장되지 않아 지문 외의 구체 변경은 표시하지 않습니다.",
			),
		).toBeNull();
		expect(screen.getByText("적용된 요청 정책 근거")).toBeTruthy();
		expect(screen.getByText("선언 리소스 지문")).toBeTruthy();
		expect(screen.getByText(`"sha256:${"9".repeat(64)}"`)).toBeTruthy();
		expect(
			screen.getByText(
				"적용 요청 값은 이 플러그인이 실제로 요청한 범위이며, 호스트 정책의 전체 허용 목록이 아닙니다.",
			),
		).toBeTruthy();
		expect(
			screen.getByText(
				"이 승인과 켜기는 에이전트 연동 선언을 보여줄 뿐, 네이티브 플러그인 설치를 허가하거나 실행하지 않습니다. 설치에는 별도 검증과 동의가 필요합니다.",
			),
		).toBeTruthy();
		expect(
			screen.getByText(
				"선언 리소스 원문은 지문으로만 묶이며 이 화면에서 직접 비교하지 않습니다. 네이티브 설치 트리는 이 플랜에 포함되지 않습니다.",
			),
		).toBeTruthy();
		expect(screen.queryByRole("button", { name: /설치/ })).toBeNull();
	});

	it("starts collapsed after the exact displayed plan has been reviewed", () => {
		render(
			<PluginPermissionPlanReview
				permission={permissionSnapshot("matches_reviewed_projection")}
				workspaceRoot="/work/repository"
			/>,
		);

		const details = screen.getByText("승인 범위 전체 보기").closest("details");
		expect(details?.open).toBe(false);
		expect(screen.queryByText("이전 검토 지문")).toBeNull();
		expect(
			screen.queryByText(
				"이전 검토 내용은 저장되지 않아 지문 외의 구체 변경은 표시하지 않습니다.",
			),
		).toBeNull();
	});

	it("shows the digest-only warning only for a legacy review", () => {
		render(
			<PluginPermissionPlanReview
				permission={permissionSnapshot("legacy_digest_only")}
				workspaceRoot="/work/repository"
			/>,
		);

		expectTechnicalField("이전 검토 지문", `sha256:${"e".repeat(64)}`);
		expect(
			screen.getByText(
				"이전 검토 내용은 저장되지 않아 지문 외의 구체 변경은 표시하지 않습니다.",
			),
		).toBeTruthy();
		expect(screen.queryByText("검토 후 변경")).toBeNull();
	});

	it("reopens a changed digest without replacing the focused disclosure", () => {
		const initial = permissionSnapshot();
		const view = render(
			<PluginPermissionPlanReview
				permission={initial}
				workspaceRoot="/work/repository"
			/>,
		);
		const firstDetails = screen
			.getByText("승인 범위 전체 보기")
			.closest("details");
		// The Disclosure label is a span inside the summary; the summary takes focus.
		const firstSummary = screen
			.getByText("승인 범위 전체 보기")
			.closest("summary") as HTMLElement;
		expect(firstDetails?.open).toBe(true);
		if (firstDetails) firstDetails.open = false;
		firstSummary.focus();

		view.rerender(
			<PluginPermissionPlanReview
				permission={{ ...initial, record_revision: "5" }}
				workspaceRoot="/work/repository"
			/>,
		);
		expect(
			screen.getByText("승인 범위 전체 보기").closest("details")?.open,
		).toBe(false);

		const changed = permissionSnapshot();
		changed.plan = {
			...changed.plan,
			digest: `sha256:${"f".repeat(64)}`,
		};
		changed.review = {
			...changed.review,
			current: {
				...changed.review.current,
				plan_digest: changed.plan.digest,
				projection_digest: `sha256:${"0".repeat(64)}`,
			},
		};
		view.rerender(
			<PluginPermissionPlanReview
				permission={changed}
				workspaceRoot="/work/repository"
			/>,
		);
		const changedSummary = screen
			.getByText("승인 범위 전체 보기")
			.closest("summary") as HTMLElement;
		expect(changedSummary.closest("details")).toBe(firstDetails);
		expect(changedSummary.closest("details")?.open).toBe(true);
		expect(changedSummary).toBe(firstSummary);
		expect(document.activeElement).toBe(firstSummary);
	});

	it("updates disclosure state when review comparison changes for the same digest", () => {
		const initial = permissionSnapshot("no_reviewed_plan");
		const view = render(
			<PluginPermissionPlanReview
				permission={initial}
				workspaceRoot="/work/repository"
			/>,
		);
		const details = screen.getByText("승인 범위 전체 보기").closest("details");
		expect(details?.open).toBe(true);

		view.rerender(
			<PluginPermissionPlanReview
				permission={{
					...initial,
					plan_comparison: "matches_reviewed_plan",
					reviewed_plan_digest: initial.plan.digest,
					review: {
						...initial.review,
						comparison: {
							status: "matches_reviewed_projection",
							reviewed_plan_digest: initial.plan.digest,
						},
					},
				}}
				workspaceRoot="/work/repository"
			/>,
		);
		expect(details?.open).toBe(false);

		view.rerender(
			<PluginPermissionPlanReview
				permission={initial}
				workspaceRoot="/work/repository"
			/>,
		);
		expect(details?.open).toBe(true);
	});

	it("renders digest-distinct free strings with an unambiguous encoding", () => {
		const permission = permissionSnapshot("no_reviewed_plan");
		permission.plan.permissions = [
			{
				kind: "dure.issue-tracker.read",
				parameters: {
					separate: ["a", "b"],
					combined: ["a, b"],
					spacing: ["a b", "a  b"],
				},
			},
		];
		permission.plan.activation = [
			{ kind: "workspace_contains", pattern: ".beads\n child" },
		];
		permission.plan.contributions[0].resource = "./contributions/a  b.json";
		permission.plan.agent_integrations[0].resource = "./agents/a b";

		render(
			<PluginPermissionPlanReview
				permission={permission}
				workspaceRoot="/work/repository"
			/>,
		);

		expect(screen.getByText('["a","b"]')).toBeTruthy();
		expect(screen.getByText('["a, b"]')).toBeTruthy();
		expect(
			screen.getByText(
				(_content, element) =>
					element?.tagName === "CODE" &&
					element.textContent === '["a b","a  b"]',
			),
		).toBeTruthy();
		expect(
			screen.getByText('Workspace에 ".beads\\n child" 항목이 있을 때'),
		).toBeTruthy();
		expect(
			screen.getByText(
				(_content, element) =>
					element?.textContent === '"./contributions/a  b.json"',
			),
		).toBeTruthy();
		expect(screen.getByText('"./agents/a b"')).toBeTruthy();
	});

	it("allows an unbroken activation pattern to wrap inside a narrow pane", () => {
		const permission = permissionSnapshot("no_reviewed_plan");
		const pattern = "x".repeat(512);
		permission.plan.activation = [{ kind: "workspace_contains", pattern }];

		render(
			<PluginPermissionPlanReview
				permission={permission}
				workspaceRoot="/work/repository"
			/>,
		);

		const item = screen
			.getByText(`Workspace에 ${JSON.stringify(pattern)} 항목이 있을 때`)
			.closest("li");
		expect(item?.className).toContain("[overflow-wrap:anywhere]");
	});

	it("makes workspace control characters visible and isolates technical values", () => {
		render(
			<PluginPermissionPlanReview
				permission={permissionSnapshot("no_reviewed_plan")}
				workspaceRoot={"/work/repo\n현재 플랜 지문:\u202edanger"}
			/>,
		);

		const field = screen.getByText(
			"요청 화면 Workspace 경로(승인 식별자 아님)",
		).parentElement;
		const value = field?.querySelector("dd");
		expect(value?.textContent).toBe(
			'"/work/repo\\n현재 플랜 지문:\\u202edanger"',
		);
		expect(value?.getAttribute("dir")).toBe("ltr");
		expect(value?.className).toContain("[unicode-bidi:isolate]");
	});
});
