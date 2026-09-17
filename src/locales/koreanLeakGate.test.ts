// Default-language gate — the product's default display language is English
// (user decision 2026-08-02, reaffirmed 2026-08-15). Korean is the lookup-key
// language, so any Korean string OUTSIDE a t() call renders as raw Korean in
// every non-Korean locale; strings that cannot travel a t() route must be
// English (user rule 2026-08-15: "언어를 못 바꾸는 곳은 다 영어로"). The
// i18nCoverage gate only sees literal t("…") keys; this gate closes the
// remaining hole across ALL of src/ (components, lib, qa — locales excluded):
// Korean string literals / JSX text that never pass through t(). The
// allowlist is SHRINK-ONLY: fix a file, delete its entry; never add one.
// Legitimate Korean *data payloads* may keep a scoped allowlist entry; the
// current entries and their reasons:
// - qa.ts, qa/imePreedit.tsx — QA fixtures where
//   the Korean text IS the test payload (CJK width, IME preedit sequences,
//   product-label selectors matched against rendered output).
// - lib/hub/sidebarLayout.ts — UNOPENED_DESKTOP crosses the hub wire as a
//   lookup key that the PHONE translates via its own catalogs
//   (mobile/src/locales/en.ts) — language-switchable at the phone boundary.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC_ROOT = join(__dirname, "..");
const CLI_ROOT = join(__dirname, "..", "..", "cli");
const EXCLUDED_TOP_DIRS = new Set(["locales"]);

function* walk(dir: string, top = true): Generator<string> {
	for (const entry of readdirSync(dir)) {
		if (entry === "node_modules" || (top && EXCLUDED_TOP_DIRS.has(entry)))
			continue;
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			yield* walk(full, false);
		} else if (
			/\.(?:tsx?|mjs)$/.test(entry) &&
			!/\.test\.(?:tsx?|mjs)$/.test(entry)
		) {
			yield full;
		}
	}
}

/** Lines that pass a Korean literal INTO t() — a legacy-chain key. The
 *  2026-08-17 migration moved every product string to semantic IDs, so any
 *  new one is a regression; the legacy chain stays only for data-driven
 *  dynamic keys (plugin manifests, hub wire keys), which are never literal
 *  t() arguments. */
function koreanKeyCallLines(source: string): number[] {
	const lines: number[] = [];
	for (const match of source.matchAll(
		/\bt\(\s*(["'`])((?:\\.|(?!\1)[\s\S])*?)\1/g,
	)) {
		if (!/[가-힣]/.test(match[2])) continue;
		lines.push(source.slice(0, match.index).split("\n").length);
	}
	return lines;
}

/** Parse literals so multiline templates and comment-like string contents are checked. */
function koreanLiteralLines(source: string, fileName = "copy.tsx"): number[] {
	const tree = ts.createSourceFile(
		fileName,
		source,
		ts.ScriptTarget.Latest,
		true,
	);
	const leaks = new Set<number>();
	function visit(node: ts.Node): void {
		if (
			(ts.isStringLiteralLike(node) ||
				ts.isTemplateHead(node) ||
				ts.isTemplateMiddle(node) ||
				ts.isTemplateTail(node) ||
				ts.isJsxText(node)) &&
			/[가-힣]/.test(node.text)
		) {
			leaks.add(
				tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1,
			);
		}
		ts.forEachChild(node, visit);
	}
	visit(tree);
	return [...leaks].sort((left, right) => left - right);
}

/** Lines whose Korean sits in a string literal or JSX text outside t("…"). */
function koreanLeakLines(source: string): number[] {
	const leaks: number[] = [];
	const blank = (match: string): string => match.replace(/[^\n]/g, " ");
	// A block comment renders nothing, so its Korean is not a leak. The
	// per-line skip below only catches lines that *start* the comment or
	// continue it with `*`; a wrapped JSX comment (`{/* … */}`) has neither on
	// its inner lines, and a quoted term inside one read as a string literal.
	const masked = source
		.replace(/\/\*[\s\S]*?\*\//g, blank)
		.replace(/\bt\(\s*(["'`])(?:\\.|(?!\1)[\s\S])*\1/g, blank);
	masked.split("\n").forEach((line, index) => {
		if (!/[가-힣]/.test(line)) return;
		if (/^\s*(\*|\/\/|\/\*)/.test(line)) return; // comment lines
		let s = line;
		s = s.replace(/\/\/[^"'`]*$/, "");
		const inString = /(["'`])(?:\\.|(?!\1).)*[가-힣](?:\\.|(?!\1).)*\1/.test(s);
		const inJsx = />[^<>{}"'`]*[가-힣][^<>{}"'`]*</.test(s);
		if (inString || inJsx) leaks.push(index + 1);
	});
	return leaks;
}

// Frozen 2026-08-15 offender set (file → leak-line count ceiling). A file may
// only shrink or disappear; new files and count regressions fail the gate.
const ALLOWLIST: Record<string, number> = JSON.parse(
	readFileSync(join(__dirname, "koreanLeakAllowlist.json"), "utf8"),
);

describe("default-English gate", () => {
	it("detects multiline help and nested error fallbacks without reading comments", () => {
		const source = [
			'// "주석"',
			"const help = `Usage:",
			`한국어 도움말 \${command}\`;`,
			`const error = \`\${cause || "오류"}\`;`,
			'const url = "https://example.test/한국어";',
		].join("\n");
		expect(koreanLiteralLines(source)).toEqual([2, 4, 5]);
		expect(koreanLiteralLines('t("번역 키")')).toEqual([1]);
	});

	it("CLI implementation literals use English without a baseline", () => {
		const offenders = [...walk(CLI_ROOT)].flatMap((file) => {
			const lines = koreanLiteralLines(readFileSync(file, "utf8"), file);
			return lines.length
				? [`${file.slice(CLI_ROOT.length + 1)}: ${lines.join(", ")}`]
				: [];
		});
		expect(offenders, "CLI help and diagnostics must use English").toEqual([]);
	});

	it("여러 줄 t() 문자열만 누수 검사에서 제외한다", () => {
		expect(koreanLeakLines('t(\n  "번역됨",\n);\nconst raw = "누수";')).toEqual(
			[4],
		);
	});

	it("블록 주석 안의 한국어는 화면에 나오지 않으므로 누수가 아니다", () => {
		expect(
			koreanLeakLines(
				'{/* 라벨 뒤에\n   "숨김 n" 을 붙인다 */}\nconst raw = "누수";',
			),
		).toEqual([3]);
	});

	it("src/** has no Korean outside t() beyond the shrink-only allowlist", () => {
		const regressions: string[] = [];
		const seen = new Set<string>();
		for (const file of walk(SRC_ROOT)) {
			const relative = file.slice(SRC_ROOT.length + 1).replace(/\\/g, "/");
			const leaks = koreanLeakLines(readFileSync(file, "utf8"));
			if (leaks.length === 0) continue;
			seen.add(relative);
			const allowed = ALLOWLIST[relative] ?? 0;
			if (leaks.length > allowed) {
				regressions.push(
					`${relative}: ${leaks.length} leaks (allowed ${allowed}) — lines ${leaks.slice(0, 5).join(", ")}`,
				);
			}
		}
		expect(
			regressions,
			`t() 밖 한국어는 영어 기본 언어에서 그대로 노출된다. 문자열을 t()로 감싸고 en 카탈로그에 항목을 추가하라:\n${regressions.join("\n")}`,
		).toEqual([]);

		// Shrink-only bookkeeping: files that no longer leak must leave the list.
		const stale = Object.keys(ALLOWLIST).filter((file) => !seen.has(file));
		expect(
			stale,
			`다음 파일은 누수가 사라졌다 — koreanLeakAllowlist.json에서 지워라:\n${stale.join("\n")}`,
		).toEqual([]);
	});

	it("src/** has no Korean literal t() keys — semantic IDs only", () => {
		const offenders: string[] = [];
		for (const file of walk(SRC_ROOT)) {
			const relative = file.slice(SRC_ROOT.length + 1).replace(/\\/g, "/");
			const lines = koreanKeyCallLines(readFileSync(file, "utf8"));
			if (lines.length > 0) {
				offenders.push(`${relative}: lines ${lines.join(", ")}`);
			}
		}
		expect(
			offenders,
			`한국어-문장 legacy 키의 신규 유입 — semantic ID로 추가하라 (이관 절차: src/lib/i18n.ts 머리말):\n${offenders.join("\n")}`,
		).toEqual([]);
	});
});
