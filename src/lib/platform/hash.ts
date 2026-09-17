// FNV-1a 32비트 해시 — 4개 모듈이 verbatim 복제하던 것을 통합(2026-08-03
// 구조 위생 감사). 출력(8자리 hex)이 종전과 동일해 persist 호환에 영향 없다.

/** FNV-1a 32비트 코어 — 포맷(hex/base36)은 호출자 계약이라 분리한다. */
export function fnv1a32(value: string): number {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

/** 짧은 결정적 지문(8자리 hex) — 표시·파일명·조인 키용(암호학적 용도 금지). */
export function fnv1a32Hex(value: string): string {
	return fnv1a32(value).toString(16).padStart(8, "0");
}

/** UTF-8 FNV-1a 64-bit fingerprint for durable contracts such as idempotency
 * keys. It is not suitable for cryptographic authentication or secret comparison. */
export function fnv1a64Hex(value: string): string {
	let hash = 0xcbf29ce484222325n;
	for (const byte of new TextEncoder().encode(value)) {
		hash ^= BigInt(byte);
		hash = BigInt.asUintN(64, hash * 0x100000001b3n);
	}
	return hash.toString(16).padStart(16, "0");
}
