/**
 * 언어 id → CodeMirror 문법 확장의 **지연 로더** (hebbian-frontend-75j).
 *
 * 예전에는 codeLangExtensions.ts가 28개 언어팩을 정적으로 import 했다. 그래서
 * TypeScript 파일 하나를 열어도 Rust·Haskell·PHP 문법까지 함께 내려받고
 * 파싱했다(editor 청크 1018kB). 이제 열린 파일의 문법만 동적으로 가져온다.
 *
 * 두 가지 소비 형태가 있어 API가 둘이다:
 * - CodeEditor는 비동기가 자연스럽다 → load*() 를 await 하고 Compartment로 넣는다.
 * - diff 데코레이션 빌더는 ViewPlugin 안의 **동기** 루프다 → peek*() 로 캐시만
 *   본다. 호출자가 먼저 preload 해서 캐시를 채우는 책임을 진다.
 *
 * vite.config.ts의 manualChunks가 문법 패키지를 editor 청크에 묶지 않도록
 * 예외 처리돼 있어야 이 동적 import가 실제로 별도 청크가 된다 — 코드만 바꾸면
 * 번들은 그대로다. 두 곳이 함께 성립해야 하는 계약이다.
 */
import {
	Language,
	LanguageSupport,
	StreamLanguage,
	type StreamParser,
} from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { type LangId, langIdFor } from "@/lib/editor/codeLang";

type Loader = () => Promise<Extension>;

const stream = (mode: StreamParser<unknown>): Extension =>
	StreamLanguage.define(mode);

/** id → 그 문법만 가져오는 동적 import. 각 항목이 별도 청크가 된다. */
const LOADERS: Record<LangId, Loader> = {
	javascript: async () =>
		(await import("@codemirror/lang-javascript")).javascript(),
	jsx: async () =>
		(await import("@codemirror/lang-javascript")).javascript({ jsx: true }),
	typescript: async () =>
		(await import("@codemirror/lang-javascript")).javascript({
			typescript: true,
		}),
	tsx: async () =>
		(await import("@codemirror/lang-javascript")).javascript({
			typescript: true,
			jsx: true,
		}),
	rust: async () => (await import("@codemirror/lang-rust")).rust(),
	go: async () => (await import("@codemirror/lang-go")).go(),
	cpp: async () => (await import("@codemirror/lang-cpp")).cpp(),
	java: async () => (await import("@codemirror/lang-java")).java(),
	python: async () => (await import("@codemirror/lang-python")).python(),
	php: async () => (await import("@codemirror/lang-php")).php(),
	json: async () => (await import("@codemirror/lang-json")).json(),
	yaml: async () => (await import("@codemirror/lang-yaml")).yaml(),
	html: async () => (await import("@codemirror/lang-html")).html(),
	xml: async () => (await import("@codemirror/lang-xml")).xml(),
	css: async () => (await import("@codemirror/lang-css")).css(),
	markdown: async () => (await import("@codemirror/lang-markdown")).markdown(),
	sql: async () => (await import("@codemirror/lang-sql")).sql(),
	swift: async () =>
		stream((await import("@codemirror/legacy-modes/mode/swift")).swift),
	ruby: async () =>
		stream((await import("@codemirror/legacy-modes/mode/ruby")).ruby),
	perl: async () =>
		stream((await import("@codemirror/legacy-modes/mode/perl")).perl),
	lua: async () =>
		stream((await import("@codemirror/legacy-modes/mode/lua")).lua),
	haskell: async () =>
		stream((await import("@codemirror/legacy-modes/mode/haskell")).haskell),
	clojure: async () =>
		stream((await import("@codemirror/legacy-modes/mode/clojure")).clojure),
	shell: async () =>
		stream((await import("@codemirror/legacy-modes/mode/shell")).shell),
	toml: async () =>
		stream((await import("@codemirror/legacy-modes/mode/toml")).toml),
	properties: async () =>
		stream(
			(await import("@codemirror/legacy-modes/mode/properties")).properties,
		),
	diff: async () =>
		stream((await import("@codemirror/legacy-modes/mode/diff")).diff),
	dockerfile: async () =>
		stream(
			(await import("@codemirror/legacy-modes/mode/dockerfile")).dockerFile,
		),
};

const extensions = new Map<LangId, Extension>();
const languages = new Map<LangId, Language | undefined>();
/** 같은 id에 대한 중복 import를 합친다 — diff 한 문서에 같은 언어 파일이
 *  여러 개 있으면 preload가 그만큼 호출된다. */
const inFlight = new Map<LangId, Promise<Extension>>();

function instanceOf(extension: Extension): Language | undefined {
	if (extension instanceof LanguageSupport) return extension.language;
	if (extension instanceof Language) return extension;
	return undefined;
}

/** id의 문법을 (필요하면 내려받아) 돌려준다. 같은 id는 한 번만 import 한다. */
export function loadLanguage(id: LangId): Promise<Extension> {
	const loaded = extensions.get(id);
	if (loaded) return Promise.resolve(loaded);
	const pending = inFlight.get(id);
	if (pending) return pending;
	const promise = LOADERS[id]()
		.then((extension) => {
			extensions.set(id, extension);
			languages.set(id, instanceOf(extension));
			return extension;
		})
		.finally(() => {
			inFlight.delete(id);
		});
	inFlight.set(id, promise);
	return promise;
}

/** 파일 이름의 문법. 모르는 형식이면 undefined(플레인 텍스트). */
export async function loadLanguageFor(
	fileName: string,
): Promise<Extension | undefined> {
	const id = langIdFor(fileName);
	return id ? await loadLanguage(id) : undefined;
}

/**
 * 이미 로드된 Language 인스턴스만 동기로 돌려준다 — diff 라인 파싱용.
 * 아직 안 받았으면 undefined이고, 그때는 강조 없이 렌더된다(내용은 그대로).
 * diff 자체 모드는 제외한다: diff 내용 라인에 diff 문법을 다시 입히면 무의미.
 */
export function peekLanguageInstanceFor(
	fileName: string,
): Language | undefined {
	const id = langIdFor(fileName);
	if (!id || id === "diff") return undefined;
	return languages.get(id);
}

/**
 * 여러 파일의 문법을 미리 받아 캐시를 채운다. diff 문서처럼 동기 루프에서
 * 강조해야 하는 소비자가 렌더 전에 호출한다. 실패한 언어는 조용히 건너뛴다 —
 * 한 언어의 청크 로드 실패가 문서 전체의 강조를 막아선 안 된다.
 */
export async function preloadLanguagesFor(
	fileNames: Iterable<string>,
): Promise<void> {
	const ids = new Set<LangId>();
	for (const fileName of fileNames) {
		const id = langIdFor(fileName);
		if (id && id !== "diff") ids.add(id);
	}
	await Promise.all(
		[...ids].map((id) => loadLanguage(id).catch(() => undefined)),
	);
}
