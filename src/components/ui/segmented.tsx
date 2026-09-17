// Segmented toggle primitive — promoted from settings/Segmented.tsx (2026-08-15)
// so non-settings callers can adopt it. The shared version adds WAI-ARIA
// radio-group semantics, keyboard navigation, and compact overflow containment.

import type * as React from "react";
import { cn } from "@/lib/utils";
import { Titled } from "@/components/ui/tooltip";

type SegmentedOption<T extends string> = {
  value: T;
  label: React.ReactNode;
  ariaLabel?: string;
  icon?: React.ReactNode;
};

/** Radio-group arrow-key navigation with wrap-around: Right/Down selects the
 * next option, Left/Up the previous one, and moving focus also selects — the
 * native segmented-control behavior. The option buttons are direct children of
 * the track in both variants, so the sibling at the target index is the button
 * to focus. */
function handleArrowKey<T extends string>(
  event: React.KeyboardEvent<HTMLButtonElement>,
  options: SegmentedOption<T>[],
  index: number,
  onChange: (v: T) => void,
) {
  const delta =
    event.key === "ArrowRight" || event.key === "ArrowDown"
      ? 1
      : event.key === "ArrowLeft" || event.key === "ArrowUp"
        ? -1
        : 0;
  if (delta === 0) return;
  event.preventDefault();
  const next = (index + delta + options.length) % options.length;
  onChange(options[next].value);
  (event.currentTarget.parentElement?.children.item(next) as HTMLElement | null)?.focus();
}

/** 2~3분할 세그먼트 토글.
 *
 *  - `outline`(기본): 맞붙은 테두리 상자 (Figma Toggle Group — 눌린 항목 bg #404040)
 *  - `pills`: muted 트랙 위에 떠 있는 알약 (시안 2524:64419의 Tabs) — 평탄화된
 *    일반 페이지가 쓴다. 외관·터미널은 각자 시안이 정해지기 전까지 outline 유지.
 */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  className,
  variant = "outline",
  size = "default",
  iconOnly = false,
}: {
  value: T;
  onChange: (v: T) => void;
  /** `icon` renders before chip labels and replaces pill labels in icon-only mode. */
  options: SegmentedOption<T>[];
  className?: string;
  /** `chips`: content-width chips that wrap onto new lines — for a longer,
   *  icon-bearing option set (e.g. a provider picker) where the equal-column
   *  outline/pills tracks would either clip or stretch. */
  variant?: "outline" | "pills" | "chips";
  /** `sm`(pills 전용): 좁은 사이드바용 축소판 — 11px(text-meta)·h-6·
   *  min-w 없음. 설정 페이지들의 기본 크기는 그대로 둔다. */
  size?: "default" | "sm";
  /** Collapse icon-bearing pill options to square buttons while preserving
   * their labels for assistive technology. */
  iconOnly?: boolean;
}) {
  if (variant === "chips") {
    return (
      // flex-wrap, not inline-grid: each chip hugs its own icon+label and the
      // set breaks into rows. Buttons remain direct children of the track so
      // handleArrowKey's sibling lookup still lands on the right chip.
      <div role="radiogroup" className={cn("flex flex-wrap items-center gap-2", className)}>
        {options.map((o, i) => (
          <button
            type="button"
            key={o.value}
            role="radio"
            aria-checked={value === o.value}
            aria-label={o.ariaLabel}
            tabIndex={value === o.value ? 0 : -1}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => handleArrowKey(e, options, i, onChange)}
            // The app's own selection language, not a row of raised buttons
            // (owner call 2026-09-14, on the Default agent comp): at rest a
            // chip is a hairline and 70% text; hover is the glass tint; the
            // chosen one wears the tint a selected sidebar row and the active
            // tab wear — the light glass pane with its hairline ring, the dark
            // 13% foreground. Height stays 32, the settings pages' control
            // height (the selects beside it, this component's outline track).
            className={cn(
              "flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium whitespace-nowrap transition-colors",
              value === o.value
                ? "border-transparent bg-glass-pane/75 text-foreground inset-ring-1 inset-ring-glass-pane-border dark:bg-foreground/[0.13] dark:inset-ring-0"
                : "border-border/60 text-foreground/70 hover:bg-glass-tint-hover hover:text-foreground",
            )}
          >
            {o.icon}
            {o.label}
          </button>
        ))}
      </div>
    );
  }
  if (variant === "pills") {
    const sm = size === "sm";
    return (
      // 트랙에 4px 여백을 두고 알약을 얹는다. 트랙은 glass/tint-hover — 사이드바
      // 행의 hover와 같은 흰색 알파 틴트라, 유리 다이얼로그 위에서 스킴 색이
      // 그대로 비친다. 전에는 bg-muted(무채색 회색)였는데 스킴 색이 도는 유리
      // 위에서 트랙만 회색 덩어리로 떴다(소유자 지적 2026-09-09). 비선택 알약의
      // hover는 글자만 밝힌다 — 트랙이 이미 그 틴트라 채움 hover는 안 보인다.
      // sm은 좁은 pane에서 긴 번역이 다음 칸을 침범하지 않도록 0까지 줄어드는
      // 균등 칸을 쓴다.
      <div
        role="radiogroup"
        className={cn(
          // The track holds the resting tone and only the selected pill rises
          // out of it — shadcn's own rule (`TabsList` is `text-muted-foreground`
          // and an active `TabsTrigger` takes `text-foreground`). Every pill
          // used to sit on the full foreground, which left the faint dark-mode
          // fill to say on its own which one was live, and it could not
          // (owner report 2026-09-08). It is also this app's rule: brightness
          // says what is worth looking at.
          "inline-grid grid-flow-col items-center rounded-lg bg-glass-tint-hover text-muted-foreground",
          sm
            ? "min-w-0 auto-cols-[minmax(0,1fr)] gap-0.5 rounded-md p-0.5"
            : "auto-cols-fr gap-1 p-1",
          className,
        )}
      >
        {options.map((o, i) => (
          <Titled key={o.value} title={
              o.ariaLabel ??
              (iconOnly && o.icon != null && typeof o.label === "string"
                ? o.label
                : undefined)
            }>
            <button
              type="button"
              role="radio"
              aria-checked={value === o.value}
              aria-label={o.ariaLabel}
              // Roving tabindex: only the selected option sits in the tab order.
              tabIndex={value === o.value ? 0 : -1}
              onClick={() => onChange(o.value)}
              onKeyDown={(e) => handleArrowKey(e, options, i, onChange)}
              className={cn(
                "font-medium whitespace-nowrap transition-colors",
                iconOnly && o.icon != null
                  ? sm
                    ? "flex size-6 shrink-0 items-center justify-center rounded-[5px] p-0"
                    : "flex size-7 shrink-0 items-center justify-center rounded-md p-0"
                  : sm
                  ? "flex h-6 min-w-0 items-center justify-center overflow-hidden rounded-[5px] px-1.5 text-meta"
                  : "h-7 min-w-[52px] rounded-md px-2 text-xs",
                // Light already matches the reference: a white pill on a grey
                // track. Dark did not — `bg-input/30` takes a 15% white token and
                // cuts it to 30%, so the pill sat 4.5% above a #3d3d3d track and
                // the lift was invisible (owner report 2026-09-08). `glass-tray`
                // is this app's raised surface at 15% white, the same one a
                // dialog's cancel stands on, and it gives dark roughly the lift
                // white-on-grey gives light.
                //
                // No outline with it. shadcn draws one in dark because its fill
                // there is 4.5% and cannot carry the state alone; at 15% the fill
                // says it, and a border would be the same thing said twice — the
                // app's own raised surface (`variant="glass"`) wears a fill and a
                // shadow and no line. The transparent border stays only to hold
                // the pill's size steady.
                // Both states carry the 1px border: only the selected option had it,
                // so the strip grew 2px on every switch and its neighbours slid
                // (owner report 2026-09-10).
                "border border-transparent",
                value === o.value
                  ? "bg-background text-foreground shadow-sm dark:bg-glass-tray"
                  : "hover:text-foreground",
              )}
            >
              {iconOnly && o.icon != null ? (
                <>
                  {o.icon}
                  <span className="sr-only">{o.label}</span>
                </>
              ) : (
                o.label
              )}
            </button>
          </Titled>
        ))}
      </div>
    );
  }
  return (
    // inline-grid + auto-cols-fr: 그룹 전체는 hug(가장 긴 라벨만큼)이면서 트랙이
    // 균등해진다. flex로 각 칸을 제 라벨에 맞춰 hug시켰더니 한 그룹 안에서
    // 52px 바닥값에 걸린 칸(실효 여백 16px)과 안 걸린 칸(패딩 6px)이 섞여
    // 여백이 들쭉날쭉했다(2026-08-05 제보). 네이티브 세그먼트 컨트롤처럼
    // 상자를 균일하게 두고 글자를 가운데 두는 쪽이 정돈돼 보인다.
    // 정확히는 첫 칸만 트랙 폭이고 나머지는 +1px이다 — 아래 -ml-px가 음수 마진이라
    // stretch가 트랙에서 마진을 뺀 만큼으로 폭을 잡는다(3칸 기준 52/53/53). 눈에
    // 띄는 차이는 아니지만 "완전히 같다"는 아니다.
    <div
      role="radiogroup"
      className={cn("inline-grid auto-cols-fr grid-flow-col items-center", className)}
    >
      {options.map((o, i) => (
        <button type="button"
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          aria-label={o.ariaLabel}
          // Roving tabindex: only the selected option sits in the tab order.
          tabIndex={value === o.value ? 0 : -1}
          onClick={() => onChange(o.value)}
          onKeyDown={(e) => handleArrowKey(e, options, i, onChange)}
          className={cn(
            // 최소 52px는 Figma Toggle(2165:36931). 예전엔 flex-1이라 폭이 컨테이너를
            // 균등 분할했고, 그래서 "Side by side" 같은 긴 라벨이 두 줄로 접혔다 —
            // 지금은 트랙이 최장 라벨 기준이라 접힐 일이 없지만, whitespace-nowrap을
            // 남겨 줄바꿈을 두 번째로 막는다.
            "h-8 min-w-[52px] border border-input px-1.5 text-xs font-medium whitespace-nowrap text-foreground",
            i > 0 && "-ml-px",
            i === 0 && "rounded-l-md",
            i === options.length - 1 && "rounded-r-md",
            value === o.value ? "z-10 bg-accent" : "bg-background hover:bg-glass-tint-hover",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
