import { useEffect, useRef } from "react";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  undo,
  redo,
} from "@codemirror/commands";
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  indentUnit,
} from "@codemirror/language";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { searchKeymap, highlightSelectionMatches, search } from "@codemirror/search";
import { editorAppearance } from "@/lib/editor/codeLangExtensions";
import { loadLanguageFor } from "@/lib/editor/codeLangLoader";
import { codeMinimap } from "@/lib/editor/codeMinimapExtension";
import { diffDocumentExtensions } from "@/lib/scm/diff/diffSyntaxExtensions";
import {
  DEFAULT_TERMINAL_LINE_HEIGHT,
  terminalFontStack,
} from "@/lib/terminal/renderer/terminalFont";
import { useActiveTerminalPalette, useResolvedDark } from "@/lib/theme/themePreference";
import { useStore } from "@/store";

/**
 * 터미널과 같은 글꼴 설정을 쓴다 — 같은 창에 나란히 뜨는 pane이라
 * 크기가 다르면 바로 티가 난다. 크기 조절(A- / A+)도 함께 따라간다.
 */
function fontTheme(fontSize: number, fontFamily: string, lineHeight: number): Extension {
  const stack = terminalFontStack(fontFamily);
  return EditorView.theme({
    "&": { fontSize: `${fontSize}px` },
    ".cm-content": { fontFamily: stack },
    ".cm-scroller": { fontFamily: stack, lineHeight: String(lineHeight) },
    ".cm-gutters": { fontFamily: stack },
  });
}

export interface CodeEditorProps {
  /** 초기 내용. 이 값이 바뀌면 문서를 통째로 교체한다(파일 새로고침). */
  value: string;
  /** 문법 강조를 고를 파일 이름 */
  fileName: string;
  readOnly?: boolean;
  /**
   * unified diff 문서 모드 — fileName의 언어 대신 diff 안 파일 경계별 언어로
   * 내용 라인에 구문 강조를 입히고, 읽기용 line-height를 쓴다.
   */
  diffDocument?: boolean;
  /**
   * 긴 줄을 접을지(true) 가로로 스크롤할지(false). 설정 › 일반 › 편집기 ›
   * Diff 줄바꿈이 diff 뷰에 이 값을 넘긴다. 기본은 접기 — 일반 파일 뷰어의
   * 기존 동작이다.
   */
  wordWrap?: boolean;
  /** 오른쪽 미니맵 스트립 표시 (설정 › 일반 › 편집기 › 미니맵) */
  minimap?: boolean;
  onChange?: (value: string) => void;
  /** Cmd/Ctrl+S */
  onSave?: () => void;
  /** 커서 위치 (1-based 줄, 열) */
  onCursor?: (line: number, col: number) => void;
  /**
   * 추가 CodeMirror 확장 (diff 라인 강조 등). Compartment로 갈아끼우므로
   * 참조가 렌더마다 바뀌어도 에디터가 재생성되지 않는다.
   */
  extraExtensions?: Extension;
  /**
   * EditorView가 처음 만들어져 상호작용 가능해진 직후 1회 호출. lazy 청크 로드가
   * 끝나고 첫 화면이 준비된 시점 — pane-open 지연 계측의 "ready" 신호로 쓴다.
   */
  onReady?: () => void;
}

export function CodeEditor({
  value,
  fileName,
  readOnly = false,
  diffDocument = false,
  wordWrap = true,
  minimap = false,
  onChange,
  onSave,
  onCursor,
  extraExtensions,
  onReady,
}: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  // 글꼴은 터미널 설정을 그대로 따른다 (상단 바 A- / A+, 설정 › 외관 › 글꼴).
  const fontSize = useStore((s) => s.terminalFontSize);
  const fontFamily = useStore((s) => s.uiPrefs?.terminalFontFamily ?? "");
  const lineHeight = useStore(
    (s) => s.uiPrefs?.terminalLineHeight ?? DEFAULT_TERMINAL_LINE_HEIGHT,
  );
  // 글꼴만 갈아끼우기 위한 칸막이 — 에디터를 다시 만들면 커서·스크롤·undo가 날아간다.
  const fontCompartmentRef = useRef(new Compartment());
  // 테마(다크/라이트·스킴)도 같은 이유로 칸막이 — 터미널 팔레트와 함께 전환된다.
  const isDark = useResolvedDark();
  const palette = useActiveTerminalPalette();
  const themeCompartmentRef = useRef(new Compartment());
  const isDarkRef = useRef(isDark);
  const paletteRef = useRef(palette);
  isDarkRef.current = isDark;
  paletteRef.current = palette;
  // 언어 문법은 지연 로드(codeLangLoader)라 마운트 시점에 없을 수 있다 —
  // 칸막이로 비워 두고 도착하면 갈아끼운다. 그래야 문법을 기다리느라 첫 paint를
  // 늦추지 않는다(파일 내용은 즉시 보인다).
  const langCompartmentRef = useRef(new Compartment());
  // extraExtensions도 같은 이유로 칸막이 — 참조 변경이 재생성으로 번지지 않게.
  // 줄바꿈·미니맵도 칸막이 — 설정을 바꿀 때마다 에디터를 다시 만들면 커서와
  // 스크롤이 튄다. 값은 ref로도 들고 있어 마운트 effect가 재실행되지 않는다.
  const wrapCompartmentRef = useRef(new Compartment());
  const minimapCompartmentRef = useRef(new Compartment());
  const wordWrapRef = useRef(wordWrap);
  const minimapRef = useRef(minimap);
  wordWrapRef.current = wordWrap;
  minimapRef.current = minimap;
  const extraCompartmentRef = useRef(new Compartment());
  const extraExtensionsRef = useRef(extraExtensions);
  extraExtensionsRef.current = extraExtensions;
  // 마운트 effect가 글꼴 변경으로 재실행되지 않도록 ref로도 들고 있는다.
  const fontSizeRef = useRef(fontSize);
  const fontFamilyRef = useRef(fontFamily);
  const lineHeightRef = useRef(lineHeight);
  fontSizeRef.current = fontSize;
  fontFamilyRef.current = fontFamily;
  lineHeightRef.current = lineHeight;
  // 콜백은 ref로 참조해 에디터를 재생성하지 않는다 — 재생성하면 커서/스크롤/
  // undo 히스토리가 전부 날아간다.
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const onCursorRef = useRef(onCursor);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;
  onCursorRef.current = onCursor;

  // 마지막으로 에디터에 반영한 외부 value. 사용자가 타이핑해 생긴 변경을
  // 다시 문서 교체로 되돌리는 루프를 막는다.
  const appliedValueRef = useRef(value);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    // diff 모드의 확장(라인 단위 강조)은 동기 구성이고, 그 안에서 쓰는 문법은
    // 플러그인이 스스로 preload 한다. 일반 파일 모드에서만 문법을 여기서 받는다.
    const lang = diffDocument ? diffDocumentExtensions(fileName) : undefined;
    const extensions: Extension[] = [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      foldGutter(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      indentUnit.of("  "),
      bracketMatching(),
      closeBrackets(),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      search({ top: true }),
      // 마운트 시점의 테마·글꼴로 시작하고, 이후 변경은 아래 effect가 재설정한다.
      themeCompartmentRef.current.of(editorAppearance(paletteRef.current, isDarkRef.current)),
      fontCompartmentRef.current.of(
        fontTheme(fontSizeRef.current, fontFamilyRef.current, lineHeightRef.current),
      ),
      wrapCompartmentRef.current.of(wordWrapRef.current ? EditorView.lineWrapping : []),
      minimapCompartmentRef.current.of(minimapRef.current ? codeMinimap : []),
      keymap.of([
        // 저장은 다른 단축키보다 먼저 잡는다.
        {
          key: "Mod-s",
          preventDefault: true,
          run: () => {
            onSaveRef.current?.();
            return true;
          },
        },
        // WKWebView에서 메뉴 단축키가 에디터로 안 오는 경우가 있어 명시적으로 건다.
        { key: "Mod-z", preventDefault: true, run: undo },
        { key: "Mod-Shift-z", preventDefault: true, run: redo },
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...foldKeymap,
        // Tab 들여쓰기. 접근성상 기본은 포커스 이동이지만 코드 편집에서는
        // 들여쓰기가 기대 동작이다.
        indentWithTab,
      ]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) {
          const next = u.state.doc.toString();
          appliedValueRef.current = next;
          onChangeRef.current?.(next);
        }
        if (u.selectionSet || u.docChanged) {
          const head = u.state.selection.main.head;
          const line = u.state.doc.lineAt(head);
          onCursorRef.current?.(line.number, head - line.from + 1);
        }
      }),
    ];
    if (lang) extensions.push(lang);
    extensions.push(langCompartmentRef.current.of([]));
    extensions.push(extraCompartmentRef.current.of(extraExtensionsRef.current ?? []));
    if (readOnly) {
      extensions.push(EditorState.readOnly.of(true), EditorView.editable.of(false));
    }

    const view = new EditorView({
      state: EditorState.create({ doc: value, extensions }),
      parent: host,
    });
    viewRef.current = view;
    appliedValueRef.current = value;
    onReadyRef.current?.();

    // 문법 청크가 도착하면 칸막이에 넣는다. 이 effect가 이미 정리됐거나 다른
    // 파일로 교체됐으면 버린다 — 늦게 온 응답이 새 문서에 엉뚱한 문법을 걸면
    // 안 된다.
    let disposed = false;
    if (!diffDocument) {
      void loadLanguageFor(fileName)
        .then((extension) => {
          if (disposed || !extension || viewRef.current !== view) return;
          view.dispatch({
            effects: langCompartmentRef.current.reconfigure(extension),
          });
        })
        .catch(() => {
          // 문법 청크 로드 실패는 플레인 텍스트로 남는다 — 파일은 계속 읽고
          // 편집할 수 있어야 한다.
        });
    }

    return () => {
      disposed = true;
      view.destroy();
      viewRef.current = null;
    };
    // value는 아래 별도 effect에서 반영한다 — 여기 넣으면 타이핑마다 재생성된다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileName, readOnly, diffDocument]);

  // extraExtensions 참조가 바뀌면 재생성 없이 칸막이만 갈아끼운다.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: extraCompartmentRef.current.reconfigure(extraExtensions ?? []),
    });
  }, [extraExtensions]);

  // 테마·스킴 전환(설정·OS) — 재생성 없이 칸막이만 갈아끼운다.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: themeCompartmentRef.current.reconfigure(editorAppearance(palette, isDark)),
    });
  }, [isDark, palette]);

  // 줄바꿈·미니맵 설정 변경 — 재생성 없이 칸막이만 갈아끼운다.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: wrapCompartmentRef.current.reconfigure(wordWrap ? EditorView.lineWrapping : []),
    });
  }, [wordWrap]);
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: minimapCompartmentRef.current.reconfigure(minimap ? codeMinimap : []),
    });
  }, [minimap]);

  // 터미널 글꼴 크기/글꼴군이 바뀌면 에디터도 즉시 따라간다.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: fontCompartmentRef.current.reconfigure(
        fontTheme(fontSize, fontFamily, lineHeight),
      ),
    });
  }, [fontSize, fontFamily, lineHeight]);

  // 외부에서 내용이 바뀐 경우(새로고침·되돌리기)만 문서를 교체한다.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || value === appliedValueRef.current) return;
    appliedValueRef.current = value;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
      selection: { anchor: Math.min(view.state.selection.main.anchor, value.length) },
    });
  }, [value]);

  return <div ref={hostRef} className="h-full w-full overflow-hidden [&_.cm-editor]:h-full" />;
}
