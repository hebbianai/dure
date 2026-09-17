// unified diff 문서에 파일별 언어 구문 강조를 입히는 CodeMirror 확장.
// 구간 계산은 diffSyntaxRegions.ts(순수), 라인 분류는 diffReview.ts(순수)를
// 쓰고 여기는 데코레이션 배선만 담당한다. 언어팩(codeLangExtensions)을
// 끌어오므로 무겁다 — CodeEditor(지연 청크)에서만 import 할 것.
//
// 방식: +/−/context 라인의 내용부(접두 1글자 제외)를 그 파일 언어의 파서로
// 라인 단위 독립 파싱해 하이라이트 마크를 얹는다. 여러 줄에 걸친 구문
// (블록 주석 등)은 그 줄에서만 흐릿해질 수 있지만, diff처럼 원문이 조각난
// 문서에서는 라인 독립 파싱이 실용적 최선이다 (전체 재조립은 rename/부분
// hunk에서 오히려 어긋난다).

import {
  RangeSetBuilder,
  StateEffect,
  type Extension,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { highlightingFor, type Language } from "@codemirror/language";
import { highlightTree, tags } from "@lezer/highlight";
import { classifyDiffLine } from "@/lib/scm/diff/diffReview";
import {
  diffFileRegions,
  regionPathAtLine,
  type DiffFileRegion,
} from "@/lib/scm/diff/diffSyntaxRegions";
import {
  peekLanguageInstanceFor,
  preloadLanguagesFor,
} from "@/lib/editor/codeLangLoader";
import { diffPathsIn } from "@/lib/scm/diff/diffSyntaxRegions";

/** 문법 청크가 도착했음을 알려 한 번 다시 칠하게 하는 신호. 언어팩이 지연
 *  로드되므로(codeLangLoader) 첫 렌더에는 캐시가 비어 있을 수 있다. */
const languagesLoaded = StateEffect.define<null>();

/** 이보다 긴 라인은 강조하지 않는다 — minified 산출물 방어. */
const MAX_HIGHLIGHT_LINE = 2_000;

function diffSyntaxPlugin(fallbackFileName: string) {
  return ViewPlugin.fromClass(
    class {
      regions: DiffFileRegion[];
      decorations: DecorationSet;
      disposed: boolean;

      constructor(view: EditorView) {
        this.regions = diffFileRegions(view.state.doc.toString());
        this.decorations = this.build(view);
        // 이 문서가 건드리는 파일들의 문법만 받아온다. 도착하면 한 번 더 칠한다
        // — 그 전까지는 강조 없이 보이지만 내용·정렬은 그대로다.
        this.disposed = false;
        void preloadLanguagesFor([
          ...diffPathsIn(this.regions),
          fallbackFileName,
        ]).then(() => {
          if (this.disposed) return;
          view.dispatch({ effects: languagesLoaded.of(null) });
        });
      }

      destroy() {
        this.disposed = true;
      }

      update(update: ViewUpdate) {
        if (update.docChanged) {
          this.regions = diffFileRegions(update.state.doc.toString());
          // 문서가 바뀌면 이전에 없던 언어가 등장할 수 있다.
          void preloadLanguagesFor(diffPathsIn(this.regions)).then(() => {
            if (this.disposed) return;
            update.view.dispatch({ effects: languagesLoaded.of(null) });
          });
        }
        // 테마/팔레트 전환은 HighlightStyle 교체(칸막이 reconfigure)로 온다 —
        // 토큰 클래스가 build 시점에 박제되므로 프로브 태그의 클래스 변화를
        // 감지해 다시 칠한다 (안 하면 스크롤 전까지 이전 팔레트 색이 남는다).
        const themeChanged =
          highlightingFor(update.startState, [tags.keyword]) !==
          highlightingFor(update.state, [tags.keyword]);
        const grammarsArrived = update.transactions.some((transaction) =>
          transaction.effects.some((effect) => effect.is(languagesLoaded)),
        );
        if (
          update.docChanged ||
          update.viewportChanged ||
          themeChanged ||
          grammarsArrived
        ) {
          this.decorations = this.build(update.view);
        }
      }

      build(view: EditorView): DecorationSet {
        const builder = new RangeSetBuilder<Decoration>();
        for (const { from, to } of view.visibleRanges) {
          let pos = from;
          while (pos <= to) {
            const line = view.state.doc.lineAt(pos);
            this.decorateLine(view, line.number, line.from, line.text, builder);
            pos = line.to + 1;
          }
        }
        return builder.finish();
      }

      decorateLine(
        view: EditorView,
        lineNumber: number,
        lineFrom: number,
        text: string,
        builder: RangeSetBuilder<Decoration>,
      ) {
        const kind = classifyDiffLine(text);
        if (kind !== "add" && kind !== "del" && kind !== "context") return;
        const path = regionPathAtLine(this.regions, lineNumber) ?? fallbackFileName;
        const language: Language | undefined = peekLanguageInstanceFor(path);
        if (!language) return;
        // context 라인 접두는 공백 1칸이지만, 잘린 diff 조각에서는 없을 수 있다.
        const offset = kind === "context" ? (text.startsWith(" ") ? 1 : 0) : 1;
        const content = text.slice(offset);
        if (content.trim() === "" || content.length > MAX_HIGHLIGHT_LINE) return;
        const tree = language.parser.parse(content);
        highlightTree(
          tree,
          { style: (tags) => highlightingFor(view.state, tags) },
          (from, to, classes) => {
            builder.add(
              lineFrom + offset + from,
              lineFrom + offset + to,
              Decoration.mark({ class: classes }),
            );
          },
        );
      }
    },
    { decorations: (v) => v.decorations },
  );
}

// 코드 diff는 터미널 line-height(1.25)가 답답하다 — 읽기 문서로서 여유를 준다.
// fontTheme는 .cm-scroller에 걸리므로 하위 .cm-content 지정이 항상 이긴다.
const diffReadingTheme = EditorView.theme({
  ".cm-content": { lineHeight: "1.5" },
  // 거터는 .cm-scroller의 1.25를 물려받아 줄 번호가 위로 치우친다 — 함께 맞춘다.
  ".cm-gutters": { lineHeight: "1.5" },
});

/**
 * diff 문서 모드 확장 묶음: 파일별 언어 구문 강조 + 읽기용 line-height.
 * fallbackFileName은 `diff --git` 경계가 없는 조각(단일 파일 diff 명령 출력)의
 * 언어 판별에 쓴다.
 */
export function diffDocumentExtensions(fallbackFileName: string): Extension {
  return [diffSyntaxPlugin(fallbackFileName), diffReadingTheme];
}
