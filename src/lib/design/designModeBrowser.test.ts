import { describe, expect, it } from "vitest";
import {
	injectionPrelude,
	remoteCapturedElement,
	remoteCaptureIntent,
	remoteCaptureKind,
} from "@/lib/design/designModeBrowser";

const captured = {
	label: "button.save",
	path: "main > button.save",
	selector: "main > button.save",
	ancestors: [],
	nearby: [],
	accessibility: {},
	html: "<button>Save</button>",
	htmlElided: false,
	css: { color: "red" },
	rect: { x: 0, y: 0, width: 1, height: 1 },
	pageRect: { x: 0, y: 0, width: 1, height: 1 },
};

describe("injectionPrelude", () => {
	it("nonce를 페이지 전역으로 심는다", () => {
		const prelude = injectionPrelude("n1");
		expect(prelude).toContain("__DURE_DESIGN_MODE_CONFIG__");
		expect(
			JSON.parse(
				prelude.slice(prelude.indexOf("{"), prelude.lastIndexOf("}") + 1),
			),
		).toEqual({ nonce: "n1" });
	});

	// 문자열 조립이므로 따옴표·스크립트 종료 시퀀스가 그대로 새면 주입이 깨진다.
	it("특수문자를 JSON으로 안전하게 넣는다", () => {
		expect(injectionPrelude('a"b</script>')).not.toContain('a"b</script>');
	});
});

describe("remoteCaptureKind / remoteCapturedElement", () => {
	it("kind를 검증해 꺼낸다", () => {
		expect(remoteCaptureKind({ kind: "pick" })).toBe("pick");
		expect(remoteCaptureKind({ kind: "cancel" })).toBe("cancel");
		expect(remoteCaptureKind({ kind: "nope" })).toBeUndefined();
		expect(remoteCaptureKind(null)).toBeUndefined();
	});

	it("정상 페이로드에서 캡처를 꺼낸다", () => {
		expect(
			remoteCapturedElement({ kind: "pick", body: { captured } })?.label,
		).toBe("button.save");
	});

	// 반쪽 캡처는 무엇을 고칠지 알 수 없는 요청이 된다. 신뢰할 수 없는 페이지가
	// 만든 값이므로 모양을 본다.
	it("필수 필드가 없으면 버린다", () => {
		expect(
			remoteCapturedElement({
				kind: "pick",
				body: { captured: { label: "x" } },
			}),
		).toBeUndefined();
		expect(remoteCapturedElement({ kind: "pick", body: {} })).toBeUndefined();
		expect(
			remoteCapturedElement({ kind: "cancel", body: { captured } }),
		).toBeUndefined();
		expect(remoteCapturedElement("string")).toBeUndefined();
	});

	it("css가 객체가 아니면 버린다", () => {
		expect(
			remoteCapturedElement({
				kind: "pick",
				body: { captured: { ...captured, css: "red" } },
			}),
		).toBeUndefined();
	});
	it("intent가 없거나 모르는 값이면 send로 본다 — 구버전 주입 호환", () => {
		const base = { kind: "pick", body: { captured: {} } };
		expect(remoteCaptureIntent(base)).toBe("send");
		expect(
			remoteCaptureIntent({
				kind: "pick",
				body: { captured: {}, intent: "copy" },
			}),
		).toBe("copy");
		expect(
			remoteCaptureIntent({
				kind: "pick",
				body: { captured: {}, intent: "??" },
			}),
		).toBe("send");
		expect(remoteCaptureIntent({ kind: "cancel" })).toBe("send");
	});
});

for (const malformed of [
	{ ancestors: null },
	{ nearby: [1] },
	{ accessibility: null },
	{ rect: { x: 0, y: 0, width: "20", height: 10 } },
	{ page: { url: 123 } },
	{ css: { color: 8 } },
]) {
	it(`rejects a capture that cannot be formatted: ${JSON.stringify(malformed)}`, () => {
		expect(
			remoteCapturedElement({
				kind: "pick",
				body: { captured: { ...captured, ...malformed } },
			}),
		).toBeUndefined();
	});
}

it("does not accept a local image path supplied by a browser page", () => {
	expect(
		remoteCapturedElement({
			kind: "pick",
			body: {
				captured: { ...captured, screenshotPath: "/tmp/page-chosen.png" },
			},
		}),
	).toEqual(captured);
});
