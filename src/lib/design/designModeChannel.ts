/**
 * 주입된 픽커 → 앱 캡처 채널 (Design Mode B단계).
 *
 * 채널은 **페이지 URL 해시 하나**다. 원격 오리진 페이지는 Tauri IPC를 쓸 수 없고,
 * 우리 오리진 iframe을 끼워도 마찬가지다 — Tauri는 IPC 부트스트랩을
 * `for_main_frame_only: true`로만 주입한다(2.11.5 manager/webview.rs:159-197,
 * 실기로도 확인: 캡처 0건). 그래서 서브프레임에는 invoke가 존재하지 않는다.
 *
 * 남는 경로는 페이지가 **자기 URL 해시에 쓰고 앱이 그것을 읽는 것**이다. Rust가
 * webview URL을 폴링해 조각을 모은다. 페이지 URL을 오염시키는 대가가 있지만
 * 대안이 없다.
 *
 * nonce는 그대로 지킨다: 페이지의 다른 스크립트도 해시를 쓸 수 있으므로 우리가
 * 발급한 nonce가 아닌 조각은 버린다.
 */

export const DESIGN_MODE_MESSAGE = "dure:design-mode:capture:v1";

export interface CaptureEnvelope {
	type: typeof DESIGN_MODE_MESSAGE;
	nonce: string;
	kind: "pick" | "cancel" | "error";
	body: unknown;
}

export function captureEnvelope(
	nonce: string,
	kind: CaptureEnvelope["kind"],
	body: unknown,
): CaptureEnvelope {
	return { type: DESIGN_MODE_MESSAGE, nonce, kind, body };
}

// ── 폴백: 해시 채널 ────────────────────────────────────────────────────────
// iframe이 막힌 페이지에서 쓴다. 페이지 URL을 오염시키므로 폴백일 뿐이고,
// 앱은 webview URL을 폴링해 조각을 모은다.

/** 조각 하나의 최대 문자 수. WebKit의 URL 길이 여유를 보수적으로 잡는다. */
const HASH_CHUNK_LIMIT = 1200;

export interface HashChunk {
	nonce: string;
	index: number;
	total: number;
	data: string;
}

const HASH_PREFIX = "dure-dm";

export function encodeHashChunks(
	nonce: string,
	payload: string,
	limit = HASH_CHUNK_LIMIT,
): string[] {
	const encoded = encodeURIComponent(payload);
	const total = Math.max(1, Math.ceil(encoded.length / limit));
	const chunks: string[] = [];
	for (let index = 0; index < total; index += 1) {
		const data = encoded.slice(index * limit, (index + 1) * limit);
		chunks.push(`${HASH_PREFIX}:${nonce}:${index}:${total}:${data}`);
	}
	return chunks;
}

export function decodeHashChunk(hash: string): HashChunk | undefined {
	const raw = hash.startsWith("#") ? hash.slice(1) : hash;
	if (!raw.startsWith(`${HASH_PREFIX}:`)) return undefined;
	// data에도 ':'가 들어갈 수 있으므로 앞 4조각만 분리한다.
	const parts = raw.split(":");
	if (parts.length < 5) return undefined;
	const [, nonce, indexRaw, totalRaw] = parts;
	const index = Number(indexRaw);
	const total = Number(totalRaw);
	if (!nonce || !Number.isInteger(index) || !Number.isInteger(total))
		return undefined;
	if (index < 0 || total <= 0 || index >= total) return undefined;
	const data = parts.slice(4).join(":");
	return { nonce, index, total, data };
}

/** 모인 조각으로 페이로드를 복원한다. 빠진 조각이 있으면 undefined —
 *  부분 페이로드를 에이전트에게 보내면 조용히 잘린 요청이 된다. */
export function joinHashChunks(
	chunks: readonly HashChunk[],
): string | undefined {
	if (chunks.length === 0) return undefined;
	const total = chunks[0].total;
	const nonce = chunks[0].nonce;
	// 구멍 있는 배열(new Array(total))에 some/forEach를 쓰면 **구멍을 건너뛴다** —
	// 그러면 빠진 조각을 못 보고 잘린 페이로드를 에이전트에게 보낸다. 명시적으로
	// 채우고 includes로 검사한다(includes는 구멍을 undefined로 본다).
	const ordered: (string | undefined)[] = Array.from(
		{ length: total },
		() => undefined,
	);
	for (const chunk of chunks) {
		if (chunk.total !== total || chunk.nonce !== nonce) return undefined;
		ordered[chunk.index] = chunk.data;
	}
	if (ordered.includes(undefined)) return undefined;
	try {
		return decodeURIComponent(ordered.join(""));
	} catch {
		return undefined;
	}
}
