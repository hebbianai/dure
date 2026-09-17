// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
	PluginPermissionReviewDiff,
	PluginPermissionReviewProjectionEvidence,
} from "@/components/plugins/PluginPermissionReviewDiff";
import type {
	PluginPermissionReviewDiffV2,
	PluginPermissionReviewProjectionV2,
} from "@/contracts/generated/extensionContracts";

afterEach(cleanup);

describe("PluginPermissionReviewProjectionEvidence", () => {
	it("shows only applied request-policy evidence and declarative resource fingerprints", () => {
		const projection: PluginPermissionReviewProjectionV2 = {
			schema_version: 2,
			plan_digest: `sha256:${"1".repeat(64)}`,
			projection_digest: `sha256:${"2".repeat(64)}`,
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
					value: { kind: "string", value: `sha256:${"3".repeat(64)}` },
				},
				{
					subject: "identity",
					field: "plugin_id",
					key_segments: [],
					value: { kind: "string", value: "must-not-appear-here" },
				},
			],
		};

		render(
			<PluginPermissionReviewProjectionEvidence projection={projection} />,
		);

		expect(screen.getByText("적용된 요청 정책 근거")).toBeTruthy();
		expect(screen.getByText("정책상 필수")).toBeTruthy();
		expect(screen.getByText("적용 요청 값")).toBeTruthy();
		expect(screen.getByText("true")).toBeTruthy();
		expect(screen.getByText('["activate","watch"]')).toBeTruthy();
		expect(screen.getByText("선언 리소스 지문")).toBeTruthy();
		expect(screen.getByText(`"sha256:${"3".repeat(64)}"`)).toBeTruthy();
		expect(
			screen.getByText(
				"적용 요청 값은 이 플러그인이 실제로 요청한 범위이며, 호스트 정책의 전체 허용 목록이 아닙니다.",
			),
		).toBeTruthy();
		expect(screen.queryByText("must-not-appear-here")).toBeNull();
	});
});

describe("PluginPermissionReviewDiff", () => {
	it("uses a distinct accessible heading id for every rendered pane", () => {
		const diff: PluginPermissionReviewDiffV2 = {
			changes: [],
			catalog_snapshot_fingerprint_only: false,
		};

		render(
			<>
				<PluginPermissionReviewDiff diff={diff} />
				<PluginPermissionReviewDiff diff={diff} />
			</>,
		);

		const regions = screen.getAllByRole("region", { name: "검토 후 변경" });
		const headingIds = regions.map((region) =>
			region.getAttribute("aria-labelledby"),
		);
		expect(new Set(headingIds).size).toBe(2);
		for (const [index, region] of regions.entries()) {
			expect(region.querySelector("h4")?.id).toBe(headingIds[index]);
		}
	});

	it("renders the backend's exact added, removed, and changed entries without rebuilding a diff", () => {
		const diff: PluginPermissionReviewDiffV2 = {
			changes: [
				{
					kind: "added",
					current: {
						subject: "contribution",
						field: "required",
						key_segments: ["dure.beads.view"],
						value: { kind: "boolean", value: true },
					},
				},
				{
					kind: "removed",
					reviewed: {
						subject: "activation",
						field: "pattern",
						key_segments: ["workspace", ".old"],
						value: { kind: "string", value: ".old" },
					},
				},
				{
					kind: "changed",
					reviewed: {
						subject: "permission",
						field: "granted_values",
						key_segments: ["scope\n\u202e\u200b", "a,b"],
						value: { kind: "string_list", values: ["a", "b"] },
					},
					current: {
						subject: "permission",
						field: "granted_values",
						key_segments: ["scope\n\u202e\u200b", "a,b"],
						value: { kind: "string_list", values: ["a, b"] },
					},
				},
				{
					kind: "changed",
					reviewed: {
						subject: "permission",
						field: "granted_values",
						key_segments: ["visually-identical"],
						value: { kind: "string_list", values: ["scope"] },
					},
					current: {
						subject: "permission",
						field: "granted_values",
						key_segments: ["visually-identical"],
						value: {
							kind: "string_list",
							values: ["scope\u200b\u{e0100}"],
						},
					},
				},
			],
			catalog_snapshot_fingerprint_only: true,
		};

		render(<PluginPermissionReviewDiff diff={diff} />);

		const region = screen.getByRole("region", { name: "검토 후 변경" });
		expect(within(region).getByText("추가됨")).toBeTruthy();
		expect(within(region).getByText("제거됨")).toBeTruthy();
		expect(within(region).getAllByText("변경됨")).toHaveLength(2);
		expect(within(region).getByText("선언상 필수")).toBeTruthy();
		expect(within(region).getByText("true")).toBeTruthy();
		expect(within(region).getAllByText('".old"').length).toBeGreaterThan(0);
		expect(within(region).getByText('"scope\\n\\u202e\\u200b"')).toBeTruthy();
		expect(within(region).getByText('"a,b"')).toBeTruthy();
		expect(within(region).getByText('["a","b"]')).toBeTruthy();
		expect(within(region).getByText('["a, b"]')).toBeTruthy();
		expect(within(region).getByText('["scope"]')).toBeTruthy();
		expect(within(region).getByText('["scope\\u200b\\u{e0100}"]')).toBeTruthy();
		expect(within(region).getAllByText("이전 값").length).toBeGreaterThan(0);
		expect(within(region).getAllByText("현재 값").length).toBeGreaterThan(0);
		expect(
			within(region).getByText(
				"선언 카탈로그 지문은 바뀌었지만 리소스 콘텐츠 지문 변경은 확인되지 않았습니다. 원문 수준 변경은 이 화면에서 추론하지 않습니다.",
			),
		).toBeTruthy();
		expect(region.textContent).not.toContain("\u202e");
		expect(region.textContent).not.toContain("\u200b");
		expect(region.textContent).not.toContain("\u{e0100}");

		for (const value of region.querySelectorAll("dd")) {
			expect(value.getAttribute("dir")).toBe("ltr");
			expect(value.className).toContain("[unicode-bidi:isolate]");
		}
		expect(region.className).not.toMatch(/overflow|scroll/);
	});
});
