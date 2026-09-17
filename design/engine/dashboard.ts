// Static inventory and token-check dashboard: generated beside the
// envelope, no server, Korean. Neutral surfaces follow design/SOUL.md;
// color calls attention to errors.

import { statSync } from "node:fs";
import { join } from "node:path";
import type { CheckResult } from "./envelope.ts";
import type { Envelope, MockupEvidence, SurfaceCandidate } from "./types.ts";

const esc = (value: string) =>
	value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");

interface ClusterRow {
	cluster: string;
	items: SurfaceCandidate[];
}

function clusterRows(surfaces: SurfaceCandidate[]): ClusterRow[] {
	const byCluster = new Map<string, SurfaceCandidate[]>();
	for (const item of surfaces) {
		const cluster = item.cluster;
		byCluster.set(cluster, [...(byCluster.get(cluster) ?? []), item]);
	}
	return [...byCluster.entries()]
		.map(([cluster, items]) => ({
			cluster,
			items: items.sort((a, b) => a.id.localeCompare(b.id)),
		}))
		.sort((a, b) => a.cluster.localeCompare(b.cluster));
}

const pct = (covered: number, total: number) =>
	total === 0 ? "–" : `${Math.round((covered / total) * 100)}%`;

/** Report source file timestamps without interpreting them as UI conformance. */
export function mockupFreshness(
	repoRoot: string,
	mockups: MockupEvidence[],
): { path: string; mtimeMs: number }[] {
	const paths = new Set<string>();
	for (const mockup of mockups) paths.add(mockup.path);
	const out: { path: string; mtimeMs: number }[] = [];
	for (const path of [...paths].sort()) {
		try {
			out.push({ path, mtimeMs: statSync(join(repoRoot, path)).mtimeMs });
		} catch {
			// A mockup can disappear between the scan and timestamp lookup.
		}
	}
	return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export function buildDashboardHtml(
	envelope: Envelope,
	check: CheckResult,
	freshness: { path: string; mtimeMs: number }[],
): string {
	const surface = envelope.surfaces;
	const token = envelope.axes.token.items;
	const clusters = clusterRows(surface);
	const coveredTokens = token.filter((item) => item.verdict === "covered").length;
	const drift = token.filter((i) => i.detail.drift);
	const deadAnchors = Object.entries(envelope.anchors).filter(([, n]) => n === 0);

	const clusterSection = clusters
		.map(
			(row) => `
		<details class="cluster">
			<summary>
				<span class="cluster-name">${esc(row.cluster)}</span>
				<span class="cluster-count">${row.items.length}</span>
			</summary>
			<ul>
				${row.items
					.map((i) => `<li><code>${esc(i.id)}</code> <span class="quiet">${esc(i.file)}</span></li>`)
					.join("")}
			</ul>
		</details>`,
		)
		.join("");

	const errorSection =
		check.errors.length === 0
			? ""
			: `
		<section class="errors">
			<h2>게이트 에러 ${check.errors.length}</h2>
			<ul>${check.errors.map((e) => `<li><code>[${esc(e.code)}]</code> ${esc(e.message)}</li>`).join("")}</ul>
		</section>`;

	const freshnessRows = freshness
		.slice(0, 12)
		.map(
			(f) =>
				`<tr><td><code>${esc(f.path)}</code></td><td>${new Date(f.mtimeMs).toISOString().slice(0, 16).replace("T", " ")}</td></tr>`,
		)
		.join("");

	return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<title>Dure design inventory</title>
<style>
	:root { color-scheme: light; }
	* { box-sizing: border-box; margin: 0; }
	body { font: 13px/1.6 -apple-system, "Apple SD Gothic Neo", sans-serif; color: #171717; background: #fdfdfc; padding: 48px; max-width: 960px; margin: 0 auto; }
	h1 { font-size: 20px; font-weight: 600; letter-spacing: -0.01em; }
	h2 { font-size: 13px; font-weight: 600; margin: 40px 0 12px; letter-spacing: 0.04em; text-transform: uppercase; color: #737373; }
	.meta { color: #a3a3a3; font-size: 11px; margin-top: 4px; font-family: ui-monospace, monospace; }
	.axes { display: flex; gap: 40px; margin: 32px 0 8px; }
	.axis-num { font-size: 34px; font-weight: 300; letter-spacing: -0.02em; }
	.axis-label { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: #737373; margin-top: 2px; }
	.axis-count { font-size: 11px; color: #a3a3a3; font-family: ui-monospace, monospace; }
	.cluster { border-top: 1px solid #ececea; }
	.cluster summary { display: flex; align-items: center; gap: 12px; padding: 9px 0; cursor: pointer; list-style: none; }
	.cluster summary::-webkit-details-marker { display: none; }
	.cluster-name { flex: 1; font-family: ui-monospace, monospace; font-size: 12px; }
	.cluster-count { font-family: ui-monospace, monospace; font-size: 11px; color: #737373; }
	.cluster ul { padding: 4px 0 12px; }
	.cluster li { list-style: none; font-size: 11px; color: #737373; }
	code { font-family: ui-monospace, monospace; font-size: 11px; }
	table { border-collapse: collapse; width: 100%; }
	td { padding: 4px 12px 4px 0; border-top: 1px solid #ececea; font-size: 12px; color: #525252; }
	.errors h2, .errors code { color: #b91c1c; }
	.quiet { color: #a3a3a3; font-size: 12px; }
	a { color: inherit; }
</style>
</head>
<body>
<h1>Dure design inventory</h1>
<div class="meta">${esc(envelope.generatedAt)} · ${esc(envelope.sourceCommit.slice(0, 8))}${envelope.dirty ? " · dirty" : ""} · 디자인 원칙: <a href="../SOUL.md">design/SOUL.md</a></div>

<div class="axes">
	<div class="axis"><div class="axis-num">${surface.length}</div><div class="axis-label">Source surfaces</div></div>
	<div class="axis"><div class="axis-num">${envelope.mockups.length}</div><div class="axis-label">Optional mockups</div></div>
	<div class="axis">
		<div class="axis-num">${pct(coveredTokens, token.length)}</div>
		<div class="axis-label">Tokens</div>
		<div class="axis-count">${coveredTokens} / ${token.length}</div>
	</div>
</div>

${errorSection}

<h2>소스 인벤토리</h2>
${clusterSection}

<h2>토큰</h2>
<p class="quiet">문서화·정합 ${coveredTokens}/${token.length} · 드리프트 ${drift.length} · 토큰 밖 raw color ${envelope.rawColors.total}${envelope.rawColors.stale.length > 0 ? ` · allowlist rot ${envelope.rawColors.stale.length}` : ""}</p>
${drift.length > 0 ? `<ul>${drift.map((i) => `<li><code>${esc(String(i.id))}</code> ${esc(String(i.detail.drift))}</li>`).join("")}</ul>` : ""}

<h2>목업 파일 수정 시점</h2>
${freshness.length === 0 ? '<p class="quiet">등록된 HTML 목업이 없습니다. 목업은 선택 사항입니다.</p>' : `<table>${freshnessRows}</table>`}

${
	envelope.excluded.length > 0
		? `<h2>제외 (${envelope.excluded.length})</h2><ul>${envelope.excluded.map((e) => `<li><code>${esc(e.id)}</code> <span class="quiet">${esc(e.reason)}</span></li>`).join("")}</ul>`
		: ""
}
${deadAnchors.length > 0 ? `<h2>Dead anchors</h2><p class="quiet">${deadAnchors.map(([id]) => esc(id)).join(", ")}</p>` : ""}
${check.shrinkable.length > 0 ? `<h2>베이스라인 축소 가능 (${check.shrinkable.length})</h2><p class="quiet">covered가 됐거나 사라진 항목 — design/design-coverage-baseline.json에서 지운다.</p>` : ""}

<p class="quiet">화면 목록은 소스에서 생성합니다. 토큰값과 등록된 목업의 경로·토큰 참조를 검사하며, 화면 동작이나 시각적 승인을 인증하지 않습니다.</p>
</body>
</html>
`;
}
