import { describe, expect, it } from "vitest";
import {
	loadLanguage,
	loadLanguageFor,
	peekLanguageInstanceFor,
	preloadLanguagesFor,
} from "@/lib/editor/codeLangLoader";

describe("codeLangLoader", () => {
	it("확장자로 그 언어의 문법만 받아온다", async () => {
		expect(await loadLanguageFor("main.rs")).toBeDefined();
	});

	it("모르는 확장자는 undefined다 — 플레인 텍스트로 열린다", async () => {
		expect(await loadLanguageFor("notes.unknownext")).toBeUndefined();
		expect(await loadLanguageFor("noextension")).toBeUndefined();
	});

	// diff 라인 강조는 동기 루프라 캐시만 본다. preload 전에는 비어 있어야
	// 하고(강조 없이 렌더), preload 후에는 파서가 있어야 한다.
	it("preload 전에는 동기 조회가 비어 있고, 후에는 파서를 준다", async () => {
		expect(peekLanguageInstanceFor("fresh.hs")).toBeUndefined();
		await preloadLanguagesFor(["fresh.hs"]);
		const language = peekLanguageInstanceFor("fresh.hs");
		expect(language).toBeDefined();
		expect(language?.parser).toBeDefined();
	});

	// diff 내용 라인에 diff 문법을 다시 입히면 무의미하다 — 명시적으로 제외한다.
	it("diff 자체는 동기 조회에서 제외한다", async () => {
		await preloadLanguagesFor(["change.diff", "change.patch"]);
		expect(peekLanguageInstanceFor("change.diff")).toBeUndefined();
		expect(peekLanguageInstanceFor("change.patch")).toBeUndefined();
	});

	// 같은 언어 파일이 diff 한 문서에 여러 개 있으면 preload가 그만큼 불린다.
	// 청크를 여러 번 받지 않도록 in-flight를 합쳐야 한다.
	it("같은 언어를 동시에 요청해도 한 인스턴스를 공유한다", async () => {
		const [first, second, third] = await Promise.all([
			loadLanguage("yaml"),
			loadLanguage("yaml"),
			loadLanguage("yaml"),
		]);
		expect(first).toBe(second);
		expect(second).toBe(third);
		// 이후 재요청도 같은 참조 — CodeMirror가 같은 확장 참조를 재계산하지 않는다.
		expect(await loadLanguage("yaml")).toBe(first);
	});

	it("여러 파일을 한 번에 preload 한다", async () => {
		await preloadLanguagesFor(["a.py", "b.json", "b.json", "c.toml"]);
		for (const file of ["a.py", "b.json", "c.toml"]) {
			expect(peekLanguageInstanceFor(file)).toBeDefined();
		}
	});

	it("StreamLanguage(legacy 모드)도 파서를 노출한다", async () => {
		await preloadLanguagesFor(["build.sh"]);
		expect(peekLanguageInstanceFor("build.sh")?.parser).toBeDefined();
	});
});

// 이 분리는 코드(동적 import)와 번들 설정(manualChunks) 두 곳이 함께 성립해야
// 유지된다. 어느 한쪽이 무너지면 editor 청크가 다시 1MB가 되는데, 번들 크기는
// 테스트가 보지 않으므로 조용히 되돌아간다 — 정적 import 재유입을 막는다.
describe("문법 패키지 정적 import 금지", () => {
	it("codeLangLoader 밖에서는 문법 패키지를 정적으로 import 하지 않는다", async () => {
		const { readdirSync, readFileSync, statSync } = await import("node:fs");
		const { join } = await import("node:path");
		const offenders: string[] = [];
		const walk = (dir: string) => {
			for (const entry of readdirSync(dir)) {
				const path = join(dir, entry);
				if (statSync(path).isDirectory()) {
					walk(path);
					continue;
				}
				if (!/\.tsx?$/.test(entry)) continue;
				if (path.endsWith("codeLangLoader.ts")) continue;
				for (const line of readFileSync(path, "utf8").split("\n")) {
					const isStaticImport =
						line.startsWith("import ") && !line.includes("await import");
					if (
						isStaticImport &&
						/@codemirror\/(lang-|legacy-modes)/.test(line)
					) {
						offenders.push(`${path}: ${line.trim()}`);
					}
				}
			}
		};
		walk("src");
		expect(offenders).toEqual([]);
	});
});
