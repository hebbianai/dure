/**
 * 사용자 앱 창에 주입되는 Design Mode 진입점 (B단계).
 *
 * 이 파일은 앱 번들이 아니라 **별도 IIFE**로 빌드된다(vite.inject.config.ts →
 * src/generated/designModeInject.js). 그래야 우리 앱의 모듈 시스템 없이 임의
 * 페이지에서 실행된다. 수집·판정은 앱과 **같은 모듈**을 쓴다 — 판정이 두 곳으로
 * 갈라지면 창마다 다른 결과가 나온다.
 *
 * 주입만으로는 아무 일도 하지 않는다. 페이지의 전역 상태를 건드리지 않기 위해
 * API만 심어두고, 사용자가 토글할 때 앱이 eval로 start()를 부른다.
 */
import {
	captureElement,
	normalizePickTarget,
	isPickableTarget,
} from "@/lib/design/designModeCapture";
import {
	captureEnvelope,
	encodeHashChunks,
} from "@/lib/design/designModeChannel";
import {
	type PickerHandle,
	startDesignModePicker,
} from "@/lib/design/designModePicker";

/** 앱이 이 이름으로 찾는다. 페이지의 다른 전역과 겹치지 않게 접두를 둔다. */
const GLOBAL = "__DURE_DESIGN_MODE__";

/** 주입 시 Rust가 심는 값. 브리지 URL과 nonce는 앱이 정한다. */
interface InjectedConfig {
	nonce: string;
	/** QA 전용: 이 셀렉터를 자동으로 집는다. 실기에서 pick 경로를 확인할 방법이
	 *  없어서(창 안 UI를 구동할 수단이 없다) 주입 설정으로만 켠다. 앱은 QA 프로브
	 *  경로에서만 이 값을 넣는다 — 일반 사용 경로는 이 필드를 만들지 않는다. */
	qaAutoPick?: string;
}

function injectedConfig(): InjectedConfig | undefined {
	const config = (
		window as unknown as { __DURE_DESIGN_MODE_CONFIG__?: InjectedConfig }
	).__DURE_DESIGN_MODE_CONFIG__;
	if (!config?.nonce) return undefined;
	return config;
}

/** 페이지 URL 해시로 조각내 보낸다. 앱(Rust)이 webview URL을 폴링해 모은다.
 *  이것이 유일한 경로다 — Tauri는 IPC 부트스트랩을 메인 프레임에만 주입하므로
 *  우리 오리진 iframe을 끼워도 invoke가 없다(실기 확인). */
function sendViaHash(config: InjectedConfig, payload: string): void {
	const chunks = encodeHashChunks(config.nonce, payload);
	let index = 0;
	const step = () => {
		if (index >= chunks.length) return;
		location.hash = chunks[index];
		index += 1;
		// 폴러가 각 조각을 볼 기회를 준다 — 한 프레임에 다 쓰면 마지막만 남는다.
		setTimeout(step, 120);
	};
	step();
}

interface DesignModeApi {
	/** 픽커를 켠다. 이미 켜져 있으면 아무 일도 하지 않는다. */
	start: () => boolean;
	/** 픽커를 끈다. */
	stop: () => void;
	active: () => boolean;
	/** 앱이 배선을 확인할 때 쓴다 — IPC가 닿는지, 어떤 버전이 주입됐는지. */
	probe: () => { version: number; ipc: boolean; active: boolean };
}

let handle: PickerHandle | null = null;

function report(kind: "pick" | "cancel" | "error", body: unknown): void {
	const config = injectedConfig();
	if (!config) {
		console.error(
			"[dure design mode] no injection config — the app did not plant a nonce",
		);
		return;
	}
	sendViaHash(
		config,
		JSON.stringify(captureEnvelope(config.nonce, kind, body)),
	);
}

const api: DesignModeApi = {
	start: () => {
		if (handle) return false;
		handle = startDesignModePicker({
			onPick: (captured, _element, intent) => {
				handle = null;
				report("pick", { captured, intent });
			},
			onCancel: () => {
				handle = null;
				report("cancel", { reason: "user" });
			},
		});
		return true;
	},
	stop: () => {
		handle?.stop();
		handle = null;
	},
	active: () => handle !== null,
	probe: () => ({
		version: 1,
		ipc: Boolean(injectedConfig()),
		active: handle !== null,
	}),
};

/** Install the standalone window bridge explicitly. Merely evaluating the
 * bundle for a Pro capture neither changes the URL nor installs listeners. */
export function install() {
	if (injectedConfig()) {
		if (document.readyState !== "loading") {
			report("cancel", { reason: "navigation" });
		} else {
			window.addEventListener("DOMContentLoaded", () => {
				report("cancel", { reason: "navigation" });
			});
		}
		(window as unknown as Record<string, unknown>)[GLOBAL] = api;
	}

	// QA 자동 픽 — 실기에서 pick 경로를 확인하기 위한 것이다. 사용자 경로에서는
	// qaAutoPick이 없으므로 아무 일도 하지 않는다.
	const qaTarget = injectedConfig()?.qaAutoPick;
	if (qaTarget) {
		const attempt = (remaining: number) => {
			const element = document.querySelector(qaTarget);
			if (!element) {
				// 페이지가 아직 그리는 중일 수 있다. 못 찾으면 오류로 알린다 — 조용히
				// 끝나면 실기 결과가 "채널 문제"로 오인된다.
				if (remaining <= 0) {
					report("error", { reason: `qa_target_not_found: ${qaTarget}` });
					return;
				}
				setTimeout(() => attempt(remaining - 1), 200);
				return;
			}
			report("pick", {
				captured: captureElement(element, { now: new Date().toISOString() }),
			});
		};
		setTimeout(() => attempt(10), 300);
	}
}

/** Capture the displayed page without activating the underlying control. A
 * keyboard invocation uses the element already focused in that page. */
export function captureAtPoint(point?: { x: number; y: number }) {
	const candidate = point
		? document.elementFromPoint(point.x, point.y)
		: document.activeElement;
	if (
		!candidate ||
		candidate === document.body ||
		candidate === document.documentElement
	) {
		throw new Error("browser_capture_target_missing");
	}
	const target = normalizePickTarget(candidate);
	if (!isPickableTarget(target))
		throw new Error("browser_capture_target_excluded");
	return captureElement(target, { now: new Date().toISOString() });
}
