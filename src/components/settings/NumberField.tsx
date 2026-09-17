import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * 숫자 입력 — 타이핑하는 동안은 건드리지 않고, 확정할 때만 정규화한다.
 *
 * 값을 곧바로 스토어에 넣고 매 글자 정규화하면 입력이 사용자와 싸운다:
 * 1000에서 백스페이스를 치면 "100"이 하한 200으로 튀어 다시는 그 아래로 못
 * 내려가고, 지우고 새로 치면 "1"→"15"→"150"이 각각 클램프돼 엉뚱한 수가 된다.
 * 그래서 초안은 문자열로 들고 있다가 blur·Enter에서만 commit한다.
 */
export function NumberField({
  value,
  onCommit,
  min,
  max,
  step,
  className,
  ariaLabel,
  title,
  autoFocus,
  onCancel,
}: {
  value: number;
  /** 확정된 원문. 정규화(클램프·기본값 복귀)는 호출자가 한다. */
  onCommit: (raw: string) => void;
  min?: number;
  max?: number;
  step?: number;
  className?: string;
  ariaLabel?: string;
  title?: string;
  autoFocus?: boolean;
  /** Escape로 취소했을 때. 없으면 그냥 원래 값으로 되돌린다. */
  onCancel?: () => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const focused = useRef(false);

  // 밖에서 값이 바뀌면 따라간다 — 단, 타이핑 중에는 덮어쓰지 않는다.
  useEffect(() => {
    if (!focused.current) setDraft(String(value));
  }, [value]);

  const commit = () => {
    focused.current = false;
    onCommit(draft);
  };

  return (
    <Input
      type="number"
      min={min}
      max={max}
      step={step}
      autoFocus={autoFocus}
      title={title}
      aria-label={ariaLabel}
      // 4px between the digits and WebKit's spin button — with no margin the
      // right-aligned value sat about a pixel from the arrows (owner request
      // 2026-09-10). The 4px come out of the right padding, not the text: a
      // w-16 field has exactly the room "1.35" needs, and the margin alone
      // clipped the last digit.
      className={cn("pr-2 text-right [&::-webkit-inner-spin-button]:ml-1", className)}
      value={draft}
      onFocus={() => {
        focused.current = true;
      }}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
          return;
        }
        if (event.key === "Escape") {
          // 설정 다이얼로그(Radix)는 document에서 Escape를 듣는다 — 막지 않으면
          // 인라인 편집을 취소하려다 창 전체가 닫힌다.
          event.preventDefault();
          event.stopPropagation();
          focused.current = false;
          setDraft(String(value));
          onCancel?.();
        }
      }}
    />
  );
}
