// 터미널 글꼴 미리보기 — SettingsDialog에서 추출 (god-file 다이어트).
import {
  DEFAULT_TERM_FONT_STACK,
  DEFAULT_TERMINAL_LINE_HEIGHT,
} from "@/lib/terminal/renderer/terminalFont";
import { t } from "@/lib/i18n";
import { useActiveTerminalPalette } from "@/lib/theme/themePreference";
import { useStore } from "@/store";

/** 선택한 글꼴군·크기를 실제로 반영해 렌더 (Figma 439-23554).
 *
 *  색은 활성 컬러 스킴의 터미널 팔레트에서 가져온다. 시안 값을 그대로 박아두면
 *  두 가지가 깨졌다 — 라이트 모드에서 본문(#c9c9d0)이 흰 배경 대비 1.65:1로
 *  읽히지 않았고, 바로 옆 스킴 피커에서 무엇을 고르든 미리보기는 그대로였다.
 *  글꼴 미리보기이자 스킴 미리보기이므로 팔레트를 따라가는 쪽이 맞다.
 *
 *  박스 높이는 200px 고정이다. 내용 높이에 맡기면 fontSize × lineHeight 만큼
 *  박스가 같이 자라고, items-stretch인 부모 행과 그 아래 섹션까지 밀려 내려간다.
 *  실제 터미널처럼 뷰포트는 그대로고 글자가 커지면 보이는 줄이 줄어야 한다.
 *
 *  가로는 잘리지 않고 접힌다 — 폭이 320px 고정이라 글자가 커지면 한 줄이
 *  넘치는데, PASS 줄이 flex(nowrap)라 오른쪽이 통째로 잘려 나갔다. 일반
 *  흐름 + break-words로 바꿔 긴 경로도 다음 줄로 넘어간다. 접힌 만큼 세로가
 *  늘어나므로 넘치는 줄은 스크롤로 닿을 수 있게 둔다(잘라내지 않는다).
 *  scrollbar-gutter는 xterm 뷰포트(index.css)와 같은 이유로 stable — 전역
 *  ::-webkit-scrollbar가 10px classic이라, 스크롤이 생기는 순간 내용 폭이
 *  284→274px로 줄며 모든 줄이 다시 접히는 점프가 난다. */
export function TerminalFontPreview() {
  const fontSize = useStore((s) => s.terminalFontSize);
  const family = useStore((s) => s.uiPrefs?.terminalFontFamily ?? "");
  const lineHeight = useStore(
    (s) => s.uiPrefs?.terminalLineHeight ?? DEFAULT_TERMINAL_LINE_HEIGHT,
  );
  const stack = family ? `'${family}', ${DEFAULT_TERM_FONT_STACK}` : DEFAULT_TERM_FONT_STACK;
  const p = useActiveTerminalPalette();
  const prompt = (
    <>
      <span style={{ color: p.magenta }}>~/dure</span>{" "}
      <span style={{ color: p.brightWhite }}>main</span>{" "}
      <span style={{ color: p.yellow }}>*</span>{" "}
      <span style={{ color: p.brightBlack }}>$</span>
    </>
  );
  return (
    <div className="flex w-[320px] shrink-0 flex-col gap-2">
      <span className="text-[11px] font-semibold tracking-[0.6px] text-muted-foreground">
        {t("common.preview")}
      </span>
      <div
        data-testid="terminal-font-preview"
        className="h-[200px] w-full overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable] break-words rounded-[11px] border bg-background px-[17px] py-4"
        style={{ fontFamily: stack, fontSize, lineHeight, color: p.foreground }}
      >
        <p>{prompt} npm test</p>
        <p>
          <span
            className="mr-2 inline-block rounded-[3px] px-[5px] font-bold"
            style={{ background: p.green, color: p.background }}
          >
            PASS
          </span>
          src/preview.test.ts
        </p>
        <p>
          <span style={{ color: p.brightGreen }}>✓</span>{" "}
          <span style={{ color: p.brightBlack }}>renders sample output</span>{" "}
          <span style={{ color: p.brightBlack }}>(3ms)</span>
        </p>
        <p className="pt-2">
          <span style={{ color: p.blue }}>def</span> <span style={{ color: p.yellow }}>total</span>
          {"(xs: "}
          <span style={{ color: p.blue }}>list</span>
          {"["}
          <span style={{ color: p.blue }}>int</span>
          {"]) -> "}
          <span style={{ color: p.blue }}>int</span>:
        </p>
        <p className="pl-5">
          <span style={{ color: p.blue }}>return</span> <span style={{ color: p.yellow }}>sum</span>
          {"(x "}
          <span style={{ color: p.blue }}>for</span>
          {" x "}
          <span style={{ color: p.blue }}>in</span>
          {" xs)"}
        </p>
        <p className="pt-2">
          {prompt}{" "}
          <span
            className="inline-block translate-y-[2px]"
            style={{ width: 8, height: fontSize + 2, background: p.cursor }}
          />
        </p>
      </div>
    </div>
  );
}
