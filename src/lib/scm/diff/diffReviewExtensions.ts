// unified diff 문서용 CodeMirror 확장 — 라인 분류는 diffReview.ts의 순수
// 로직을 쓰고, 여기는 데코레이션/테마 배선만 담당한다 (codeLang.ts /
// codeLangExtensions.ts 분리와 같은 규칙).

import { RangeSetBuilder, type Extension } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { classifyDiffLine, type DiffLineKind } from "@/lib/scm/diff/diffReview";

const lineDeco: Partial<Record<DiffLineKind, Decoration>> = {
  add: Decoration.line({ class: "cm-diffline-add" }),
  del: Decoration.line({ class: "cm-diffline-del" }),
  hunk: Decoration.line({ class: "cm-diffline-hunk" }),
  meta: Decoration.line({ class: "cm-diffline-meta" }),
};

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos);
      const deco = lineDeco[classifyDiffLine(line.text)];
      if (deco) builder.add(line.from, line.from, deco);
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

const highlightPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

// baseTheme emits these values verbatim into a stylesheet, so var()/color-mix
// resolve at render time against the app's --vcs-* tokens (theme-aware).
const diffTheme = EditorView.baseTheme({
  ".cm-diffline-add": {
    backgroundColor: "color-mix(in srgb, var(--vcs-added) 16%, transparent)",
  },
  ".cm-diffline-del": {
    backgroundColor: "color-mix(in srgb, var(--vcs-deleted) 16%, transparent)",
  },
  ".cm-diffline-hunk": {
    backgroundColor: "color-mix(in srgb, var(--vcs-renamed) 14%, transparent)",
  },
  ".cm-diffline-meta": { opacity: "0.65" },
});

/** +/−/hunk/헤더 라인을 배경색으로 강조하는 읽기 전용 diff 뷰 확장. */
export const diffLineHighlight: Extension = [highlightPlugin, diffTheme];
