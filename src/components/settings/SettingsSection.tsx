// 평탄화된 설정 페이지의 뼈대 — 작은 섹션 라벨 + 설정 행.
// 시안 2524:64419(일반)에서 처음 나왔고 2524:60682(터미널)이 같은 문법을 쓴다.
// FlatRow(카드 안 행)와 달리 카드가 없는 페이지를 전제한다.

import { cn } from "@/lib/utils";

/** 섹션 — 작은 라벨 하나와 행들. 첫 섹션만 hairline 없이 시작한다.
 *  라벨은 선택이다 — 외관 페이지의 앞 두 구획처럼 시안이 이름을 붙이지 않은
 *  구획도 같은 여백·hairline 리듬을 써야 한다.
 *  pt-2는 바깥 래퍼의 gap-6(24px)에 8px을 더해 시안의 제목-첫 라벨 32px을 만든다. */
export function SettingsSection({
  label,
  first,
  className,
  children,
}: {
  label?: string;
  first?: boolean;
  /** Content-column overrides — adopters keep their own row gap here
   *  (tailwind-merge lets e.g. `gap-4`/`gap-0` win over the base `gap-6`). */
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className={cn(
        "flex w-full flex-col gap-3",
        first ? "pt-2 pb-6" : "border-t border-border py-6",
      )}
    >
      {label && (
        <span className="text-[11px] leading-[18px] font-medium text-muted-foreground">
          {label}
        </span>
      )}
      <div className={cn("flex w-full flex-col gap-6", className)}>{children}</div>
    </section>
  );
}

/** 설정 한 줄 — 왼쪽 라벨(+설명), 오른쪽 컨트롤.
 *
 *  정렬은 컨트롤의 덩치를 따른다(시안): 스위치는 20px밖에 안 돼 제목 줄에
 *  붙이고, 상자형 컨트롤(선택·탭·인풋)은 두 줄 높이의 가운데에 놓는다. */
export function SettingRow({
  title,
  desc,
  leading,
  align = "start",
  children,
}: {
  title: string;
  /** A string, or a node when the value wants its own type (a mono path). */
  desc?: React.ReactNode;
  /** Glyph seated on the title line, before the text (e.g. a provider logo).
   *  Size only — the glyph owns its own color. */
  leading?: React.ReactNode;
  align?: "start" | "center";
  children?: React.ReactNode;
}) {
  return (
    <div className={cn("flex w-full gap-3", align === "center" ? "items-center" : "items-start")}>
      <div className="flex min-w-px flex-1 flex-col gap-1.5">
        <span className="flex items-center gap-1.5 text-sm leading-none font-medium text-foreground">
          {leading}
          {title}
        </span>
        {desc && <p className="text-xs text-muted-foreground">{desc}</p>}
      </div>
      {children && <div className="shrink-0">{children}</div>}
    </div>
  );
}
