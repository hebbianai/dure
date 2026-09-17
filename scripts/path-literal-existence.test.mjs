// 코드 밖 경로 문자열의 실존 검사 — 폴더 재배치의 마지막 사각지대.
//
// import 재작성은 모듈 지정자만 고친다. scripts/tools가 문자열로 든 src/ 경로
// (게이트 분류기 목록, 미디어 캡처의 /src/... 동적 import 등)는 이동 후에도
// 옛 경로를 조용히 가리킨다 — 2026-08-01 lib 재배치에서 hmux 스모크 분류기가
// 실제로 이렇게 무력화됐다(FRONTEND_RUNTIME_PATHS 드리프트). 여기서 고정한다.
//
// 테스트 파일(*.test.mjs)은 제외한다 — 픽스처가 임시 루트에 합성 경로를 쓴다.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);

const SCAN_ROOTS = ["scripts", "tools", ".githooks"];
const SCAN_EXTENSIONS = new Set([".mjs", ".sh"]);
// 데모 저장소 스캐폴딩은 가짜 repo 안에 src/… 파일을 "생성"한다 — 이 저장소의
// src/를 참조하는 게 아니므로 실존 검사 대상이 아니다.
const SCAN_EXCLUDED_DIRS = [path.join("tools", "media-capture", "providers")];
// 따옴표로 감싼 src/ 경로 리터럴. 글롭·보간이 섞인 문자열은 대상이 아니다.
const PATH_LITERAL = /["'](src\/[A-Za-z0-9_./-]+\.[a-z]+)["']/g;

function* walk(dir) {
	for (const entry of readdirSync(dir)) {
		const full = path.join(dir, entry);
		if (statSync(full).isDirectory()) {
			if (entry === "node_modules" || entry === "target") continue;
			yield* walk(full);
			continue;
		}
		yield full;
	}
}

describe("path literal existence", () => {
	it("scripts·tools·훅의 src/ 경로 문자열은 실제 파일을 가리킨다", () => {
		const stale = [];
		let scanned = 0;
		for (const rootName of SCAN_ROOTS) {
			const root = path.join(repoRoot, rootName);
			if (!existsSync(root)) continue;
			for (const file of walk(root)) {
				if (!SCAN_EXTENSIONS.has(path.extname(file))) continue;
				if (file.endsWith(".test.mjs")) continue;
				const relative = path.relative(repoRoot, file);
				if (SCAN_EXCLUDED_DIRS.some((dir) => relative.startsWith(dir))) {
					continue;
				}
				const source = readFileSync(file, "utf8");
				for (const match of source.matchAll(PATH_LITERAL)) {
					const literal = match[1];
					if (literal.includes("*") || literal.includes("${")) continue;
					scanned += 1;
					if (!existsSync(path.join(repoRoot, literal))) {
						stale.push(`${path.relative(repoRoot, file)} → ${literal}`);
					}
				}
			}
		}
		expect(stale).toEqual([]);
		// 스캔 자체가 조용히 죽으면 0건으로도 통과한다 — 하한으로 고정.
		expect(scanned).toBeGreaterThan(5);
	});
});
