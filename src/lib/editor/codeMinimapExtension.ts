// 미니맵 확장 — 기하 계산은 codeMinimap.ts의 순수 로직을 쓰고, 여기는
// 캔버스/포인터 배선만 담당한다 (diffReviewExtensions.ts와 같은 분리 규칙).
//
// 글자를 렌더하지 않고 줄마다 "들여쓰기~내용 길이" 막대만 그린다. VS Code의
// renderCharacters:false와 같은 접근인데, 이 앱의 pane 폭(보통 400~700px)에서는
// 글자를 그려도 읽히지 않아 비용만 든다.

import type { Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import {
  MINIMAP_COLUMN_WIDTH,
  MINIMAP_WIDTH,
  minimapBar,
  minimapLayout,
  minimapSampledLines,
  minimapScrollTop,
  minimapViewport,
} from "@/lib/editor/codeMinimap";

/** 캔버스 막대 색 — 에디터 본문 색을 그대로 쓰되 옅게 깔아 코드의 '모양'만
 *  남긴다. 테마(다크/라이트·스킴)가 바뀌면 다음 그리기에서 따라온다. */
const BAR_ALPHA = 0.45;

class MinimapView {
  private readonly strip: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly box: HTMLDivElement;
  private readonly onScroll: () => void;
  private dragging = false;
  private frame: number | null = null;

  constructor(private readonly view: EditorView) {
    this.strip = document.createElement("div");
    this.strip.className = "cm-minimap";
    this.strip.setAttribute("aria-hidden", "true");

    this.canvas = document.createElement("canvas");
    this.canvas.className = "cm-minimap-canvas";
    this.strip.appendChild(this.canvas);

    this.box = document.createElement("div");
    this.box.className = "cm-minimap-viewport";
    this.strip.appendChild(this.box);

    this.strip.addEventListener("pointerdown", this.handlePointerDown);
    this.strip.addEventListener("pointermove", this.handlePointerMove);
    this.strip.addEventListener("pointerup", this.handlePointerUp);
    this.strip.addEventListener("pointercancel", this.handlePointerUp);

    view.dom.appendChild(this.strip);

    // 스크롤은 ViewUpdate로 오지 않는 경우가 있어(같은 뷰포트 안 이동) 직접 듣는다.
    this.onScroll = () => this.schedule();
    view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
    this.schedule();
  }

  update(update: ViewUpdate) {
    if (update.docChanged || update.geometryChanged || update.viewportChanged) this.schedule();
  }

  destroy() {
    this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
    this.strip.removeEventListener("pointerdown", this.handlePointerDown);
    this.strip.removeEventListener("pointermove", this.handlePointerMove);
    this.strip.removeEventListener("pointerup", this.handlePointerUp);
    this.strip.removeEventListener("pointercancel", this.handlePointerUp);
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.strip.remove();
  }

  /** 스크롤/편집이 몰려 들어와도 프레임당 한 번만 그린다. */
  private schedule() {
    if (this.frame !== null) return;
    const raf =
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame
        : (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16) as unknown as number;
    this.frame = raf(() => {
      this.frame = null;
      this.draw();
    });
  }

  private draw() {
    const scroller = this.view.scrollDOM;
    const stripHeight = this.strip.clientHeight || scroller.clientHeight;
    const doc = this.view.state.doc;
    const layout = minimapLayout(doc.lines, stripHeight);

    const box = minimapViewport({
      scrollTop: scroller.scrollTop,
      clientHeight: scroller.clientHeight,
      scrollHeight: scroller.scrollHeight,
      drawnHeight: layout.drawnHeight,
    });
    this.box.style.top = `${box.top}px`;
    this.box.style.height = `${box.height}px`;
    this.box.style.display = box.height > 0 ? "" : "none";

    const context = this.canvas.getContext?.("2d");
    // jsdom 등 캔버스가 없는 환경에서는 상자만 유지하고 조용히 넘어간다.
    if (!context) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const pixelWidth = Math.round(MINIMAP_WIDTH * dpr);
    const pixelHeight = Math.max(1, Math.round(stripHeight * dpr));
    if (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight) {
      this.canvas.width = pixelWidth;
      this.canvas.height = pixelHeight;
    }
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, MINIMAP_WIDTH, stripHeight);
    context.globalAlpha = BAR_ALPHA;
    context.fillStyle = getComputedStyle(this.view.contentDOM).color || "#888";

    const maxColumns = Math.floor(MINIMAP_WIDTH / MINIMAP_COLUMN_WIDTH);
    const barHeight = Math.max(0.5, layout.rowHeight - (layout.rowHeight > 1.5 ? 0.5 : 0));
    let row = 0;
    for (const lineIndex of minimapSampledLines(layout, doc.lines)) {
      const y = row * layout.rowHeight;
      row++;
      const { indent, length } = minimapBar(doc.line(lineIndex + 1).text);
      if (length <= 0) continue;
      const start = Math.min(maxColumns, indent);
      const width = Math.min(maxColumns - start, length) * MINIMAP_COLUMN_WIDTH;
      if (width <= 0) continue;
      context.fillRect(start * MINIMAP_COLUMN_WIDTH, y, width, barHeight);
    }
    context.globalAlpha = 1;
  }

  /** 스트립 좌표계의 포인터 y → 에디터 scrollTop. */
  private scrollToPointer(event: PointerEvent) {
    const scroller = this.view.scrollDOM;
    const rect = this.strip.getBoundingClientRect();
    const layout = minimapLayout(this.view.state.doc.lines, rect.height);
    scroller.scrollTop = minimapScrollTop({
      pointerY: event.clientY - rect.top,
      drawnHeight: layout.drawnHeight,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
    });
  }

  private readonly handlePointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    this.dragging = true;
    this.strip.setPointerCapture?.(event.pointerId);
    this.scrollToPointer(event);
  };

  private readonly handlePointerMove = (event: PointerEvent) => {
    if (!this.dragging) return;
    event.preventDefault();
    this.scrollToPointer(event);
  };

  private readonly handlePointerUp = (event: PointerEvent) => {
    if (!this.dragging) return;
    this.dragging = false;
    this.strip.releasePointerCapture?.(event.pointerId);
  };
}

const minimapPlugin = ViewPlugin.fromClass(MinimapView);

const minimapTheme = EditorView.theme({
  // .cm-editor는 position:relative라 스트립을 그 위에 그대로 얹을 수 있다.
  ".cm-minimap": {
    position: "absolute",
    top: "0",
    right: "0",
    bottom: "0",
    width: `${MINIMAP_WIDTH}px`,
    overflow: "hidden",
    cursor: "pointer",
    zIndex: "3",
  },
  ".cm-minimap-canvas": {
    display: "block",
    width: `${MINIMAP_WIDTH}px`,
    height: "100%",
  },
  ".cm-minimap-viewport": {
    position: "absolute",
    left: "0",
    right: "0",
    backgroundColor: "currentColor",
    opacity: "0.12",
    pointerEvents: "none",
  },
  // 본문이 스트립 밑으로 흘러 들어가지 않게 자리를 비운다. 줄바꿈이 켜져 있으면
  // 이 패딩이 곧 줄바꿈 지점이 된다.
  ".cm-content": { paddingRight: `${MINIMAP_WIDTH + 6}px` },
  ".cm-scroller::-webkit-scrollbar": { width: "0" },
});

/** 문서 전체 모양을 오른쪽 스트립에 축소해 보여주는 미니맵. 클릭·드래그로
 *  그 위치로 스크롤한다. 설정 › 일반 › 편집기 › 미니맵에서 켜고 끈다. */
export const codeMinimap: Extension = [minimapPlugin, minimapTheme];
