// 터미널 컨테이너 박스 캐시 — 강제 동기 레이아웃 제거의 핵심 (2026-08-02
// 렉 조사: stall과 getBoundingClientRect 호출량의 1:1 상관 실측, bead wh4x).
//
// 원리: pane마다 이미 붙어 있는 ResizeObserver는 크기를 "레이아웃 계산이
// 끝난 시점에" 공짜로 전달한다. fit 게이트·GPU 측정처럼 width/height만
// 필요한 소비자가 매번 getBoundingClientRect를 부르면, 에이전트 출력으로
// DOM이 계속 dirty한 상태에선 호출마다 워크스페이스 전체가 동기 재레이아웃
// 된다(pane 수에 비례). 이 캐시는 RO 전달값을 저장해 그 읽기를 없앤다.
//
// 정확성 경계:
// - 첫 RO 전달 전에는 라이브로 한 번 읽는다 — WKWebView는 첫 레이아웃의
//   RO 전달이 불안정하다(TerminalView의 기존 주석). 이후엔 RO가 유일한
//   갱신원이다.
// - 위치(left/top)는 다루지 않는다 — 위치는 IntersectionObserver가 소유한다.
//   presentation readiness는 workspace/pane의 semantic visibility와 이 캐시의
//   non-zero size를 조합해 live rect로 dirty DOM을 강제 layout하지 않는다.

export interface TerminalBox {
	width: number;
	height: number;
}

export class TerminalBoxCache {
	private box: TerminalBox | null = null;

	constructor(private readonly readLive: () => TerminalBox) {}

	/** ResizeObserver 콜백에서 호출 — border-box 우선, 구형 폴백은 contentRect. */
	updateFromEntry(entry: ResizeObserverEntry): boolean {
		const borderBox = entry.borderBoxSize?.[0];
		const next = borderBox
			? { width: borderBox.inlineSize, height: borderBox.blockSize }
			: { width: entry.contentRect.width, height: entry.contentRect.height };
		const changed =
			this.box === null ||
			this.box.width !== next.width ||
			this.box.height !== next.height;
		this.box = next;
		return changed;
	}

	/**
	 * The last RO-delivered box without any live read. A retained terminal
	 * inside a content-visibility:hidden desktop receives skipped (zero) boxes;
	 * the reveal uses this to decide whether the next RO delivery, not a forced
	 * layout, must drive its repaint and geometry.
	 */
	delivered(): TerminalBox | null {
		return this.box;
	}

	/** 캐시된 박스 — 첫 RO 전달 전에만 라이브 읽기(1회성 강제 레이아웃 허용). */
	read(): TerminalBox {
		if (this.box) return this.box;
		// 캐시하지 않는다 — RO 첫 전달이 올 때까지는 매번 진실을 읽어야
		// 마운트 직후(0×0 → 실크기) 전이를 놓치지 않는다.
		return this.readLive();
	}

	/** TerminalFitGate의 element 계약({ getBoundingClientRect })을 그대로
	 *  만족하는 파사드 — 게이트 모듈 무수정으로 캐시를 물린다. */
	get rectFacade(): { getBoundingClientRect(): TerminalBox } {
		return { getBoundingClientRect: () => this.read() };
	}
}
