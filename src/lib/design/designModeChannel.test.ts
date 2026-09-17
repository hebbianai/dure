import { describe, expect, it } from "vitest";
import {
	captureEnvelope,
	DESIGN_MODE_MESSAGE,
	decodeHashChunk,
	encodeHashChunks,
	joinHashChunks,
} from "@/lib/design/designModeChannel";

describe("captureEnvelope", () => {
	it("nonce와 kind를 담은 봉투를 만든다 — 해시 페이로드의 모양이다", () => {
		expect(captureEnvelope("n1", "pick", { a: 1 })).toEqual({
			type: DESIGN_MODE_MESSAGE,
			nonce: "n1",
			kind: "pick",
			body: { a: 1 },
		});
	});
});

describe("해시 채널", () => {
	it("짧은 페이로드는 한 조각", () => {
		const chunks = encodeHashChunks("n1", "hello");
		expect(chunks).toHaveLength(1);
		expect(decodeHashChunk(`#${chunks[0]}`)).toMatchObject({
			nonce: "n1",
			index: 0,
			total: 1,
		});
	});

	it("긴 페이로드를 조각내고 원문으로 복원한다", () => {
		const payload = JSON.stringify({
			html: "<div>".repeat(900),
			note: "코드 리뷰",
		});
		const chunks = encodeHashChunks("n2", payload, 200);
		expect(chunks.length).toBeGreaterThan(1);
		const decoded = chunks.map((chunk) => decodeHashChunk(chunk)!);
		expect(joinHashChunks(decoded)).toBe(payload);
	});

	it("순서가 뒤섞여도 복원한다 — 폴링은 순서를 보장하지 않는다", () => {
		const payload = "a".repeat(500);
		const decoded = encodeHashChunks("n3", payload, 100).map(
			(c) => decodeHashChunk(c)!,
		);
		expect(joinHashChunks([...decoded].reverse())).toBe(payload);
	});

	// 부분 페이로드를 에이전트에게 보내면 조용히 잘린 요청이 된다.
	it("조각이 빠지면 복원하지 않는다", () => {
		const decoded = encodeHashChunks("n4", "b".repeat(500), 100).map(
			(c) => decodeHashChunk(c)!,
		);
		expect(joinHashChunks(decoded.slice(1))).toBeUndefined();
	});

	it("nonce가 섞인 조각은 복원하지 않는다", () => {
		const a = encodeHashChunks("n5", "x".repeat(300), 100).map(
			(c) => decodeHashChunk(c)!,
		);
		const b = encodeHashChunks("n6", "y".repeat(300), 100).map(
			(c) => decodeHashChunk(c)!,
		);
		expect(joinHashChunks([a[0], b[1], a[2]])).toBeUndefined();
	});

	it("우리 것이 아닌 해시는 무시한다", () => {
		expect(decodeHashChunk("#section-2")).toBeUndefined();
		expect(decodeHashChunk("")).toBeUndefined();
		expect(decodeHashChunk("#dure-dm:n1:0")).toBeUndefined();
	});

	it("data에 콜론이 있어도 복원한다", () => {
		const payload = 'url: "http://x:3000/a"';
		const decoded = encodeHashChunks("n7", payload).map(
			(c) => decodeHashChunk(c)!,
		);
		expect(joinHashChunks(decoded)).toBe(payload);
	});

	it("index가 total 밖이면 버린다", () => {
		expect(decodeHashChunk("#dure-dm:n1:5:2:data")).toBeUndefined();
	});
});
