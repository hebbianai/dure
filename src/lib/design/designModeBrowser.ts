/**
 * 사용자 앱 창을 열고, 그 창에서 온 캡처를 앱으로 잇는다 (Design Mode B단계).
 */
import { nanoid } from "nanoid";
import injectSource from "@/generated/designModeInject.js?raw";
import type { CapturedElement } from "@/lib/design/designModeCapture";
import { designModeOpenBrowser } from "@/lib/ipc";
import { isRecord as record } from "@/lib/payloadGuards";

export const DESIGN_MODE_CAPTURE_EVENT = "dure://design-mode/capture";

/** 주입 스크립트 앞에 붙는 설정. nonce는 창마다 새로 만든다 — 재사용하면 이전
 *  창의 메시지가 새 창의 것으로 받아들여질 수 있다. */
export function injectionPrelude(nonce: string, qaAutoPick?: string): string {
	const config = qaAutoPick ? { nonce, qaAutoPick } : { nonce };
	return `window.__DURE_DESIGN_MODE_CONFIG__=${JSON.stringify(config)};`;
}

export interface OpenedDesignBrowser {
	nonce: string;
	label: string;
}

/** 창을 열고 픽커를 주입한다. 반환된 nonce로 이후 캡처를 검증한다. */
export async function openDesignModeBrowser(
	url: string,
	/** QA 전용 자동 픽 셀렉터 — 실기에서 pick 경로를 확인할 때만 쓴다. */
	qaAutoPick?: string,
): Promise<OpenedDesignBrowser> {
	const nonce = nanoid();
	const script = `${injectionPrelude(nonce, qaAutoPick)}\n${injectSource}\n__DureDesignModeBundle.install();`;
	const label = await designModeOpenBrowser(url, script, nonce);
	return { nonce, label };
}

/** 창에서 온 페이로드. 브리지가 해석하지 않고 넘긴 것이므로 여기서 모양을 본다 —
 *  신뢰할 수 없는 페이지가 만든 값이다. */
export interface RemoteCaptureMessage {
	kind: "pick" | "cancel" | "error";
	body?: unknown;
}

export function remoteCaptureKind(
	payload: unknown,
): RemoteCaptureMessage["kind"] | undefined {
	if (typeof payload !== "object" || payload === null) return undefined;
	const kind = (payload as { kind?: unknown }).kind;
	return kind === "pick" || kind === "cancel" || kind === "error"
		? kind
		: undefined;
}

/**
 * 페이로드에서 캡처를 꺼낸다. 필수 필드가 없으면 undefined — 반쪽 캡처를
 * 에이전트에게 보내면 무엇을 고쳐야 하는지 알 수 없는 요청이 된다.
 */
/** 봉투의 intent. 구버전 주입(필드 없음)은 send로 본다 — 기존 계약 유지. */
export function remoteCaptureIntent(payload: unknown): "send" | "copy" {
	if (remoteCaptureKind(payload) !== "pick") return "send";
	const intent = (payload as { body?: { intent?: unknown } }).body?.intent;
	return intent === "copy" ? "copy" : "send";
}

export function remoteCapturedElement(
	payload: unknown,
): CapturedElement | undefined {
	if (remoteCaptureKind(payload) !== "pick") return undefined;
	const body = (payload as { body?: unknown }).body;
	const captured = (body as { captured?: unknown } | undefined)?.captured;
	if (typeof captured !== "object" || captured === null) return undefined;
	const candidate = captured as Partial<CapturedElement>;
	const strings = (value: unknown) =>
		Array.isArray(value) && value.every((item) => typeof item === "string");
	const finite = (value: unknown) =>
		typeof value === "number" && Number.isFinite(value);
	const rect = (value: unknown) =>
		record(value) &&
		["x", "y", "width", "height"].every((key) => finite(value[key])) &&
		(value.width as number) >= 0 &&
		(value.height as number) >= 0;
	if (
		![
			candidate.label,
			candidate.path,
			candidate.html,
			candidate.selector,
		].every((value) => typeof value === "string") ||
		typeof candidate.htmlElided !== "boolean" ||
		!strings(candidate.ancestors) ||
		!strings(candidate.nearby) ||
		!rect(candidate.rect) ||
		!rect(candidate.pageRect) ||
		!record(candidate.css) ||
		!Object.values(candidate.css).every((value) => typeof value === "string") ||
		!record(candidate.accessibility) ||
		!(["role", "accessibleName", "ariaLabel", "ariaLabelledBy"] as const).every(
			(key) =>
				candidate.accessibility?.[key] === undefined ||
				typeof candidate.accessibility?.[key] === "string",
		) ||
		![
			candidate.source,
			candidate.selectedText,
			candidate.component,
			candidate.screenshotPath,
		].every((value) => value === undefined || typeof value === "string")
	)
		return undefined;
	const page = candidate.page;
	if (
		page !== undefined &&
		(!record(page) ||
			![page.url, page.title, page.capturedAt].every(
				(value) => typeof value === "string",
			) ||
			![
				page.viewportWidth,
				page.viewportHeight,
				page.scrollX,
				page.scrollY,
				page.devicePixelRatio,
			].every(finite))
	)
		return undefined;
	// Image paths are created by the app after parsing, never by a page.
	const { screenshotPath: _untrustedPath, ...element } =
		candidate as CapturedElement;
	return element;
}
