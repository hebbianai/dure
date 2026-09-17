// 창 간 포커스 컨텍스트 방송 — 소스 제어 별도 창의 follow 모드용
// (hebbian-frontend-slds). focusCtx는 창-로컬(ephemeral)이라 persist 동기화
// (agent-ide 키)에 실리지 않는다. 메인 창이 전용 localStorage 키로 방송하고
// 보조 창이 storage 이벤트로 따라간다.
import { useEffect, useState } from "react";
import { useStore } from "@/store";

/** 스토어 focusCtx와 단일 소스 — 필드가 늘면 방송 파서도 컴파일에서 잡힌다. */
export type FocusCtxSnapshot = NonNullable<ReturnType<typeof useStore.getState>["focusCtx"]>;

const FOCUS_CTX_BROADCAST_KEY = "agent-ide-focus-ctx";

/** 방송 페이로드 파싱 (순수) — 형태가 어긋나면 null (구버전/손상 무해화). */
export function parseFocusCtxSnapshot(raw: string | null): FocusCtxSnapshot | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (v === null || typeof v !== "object") return null;
    const c = v as Record<string, unknown>;
    if (typeof c.cwd !== "string" || typeof c.label !== "string") return null;
    if (c.source !== "local" && c.source !== "ssh") return null;
    return {
      key: typeof c.key === "string" ? c.key : undefined,
      cwd: c.cwd,
      source: c.source,
      hostId: typeof c.hostId === "string" ? c.hostId : undefined,
      label: c.label,
    };
  } catch {
    return null;
  }
}

/** 메인 창에서 1회 설치 — focusCtx 변화를 방송한다. 반환값은 해제 함수. */
export function startFocusCtxBroadcast(): () => void {
  const publish = (ctx: unknown) => {
    try {
      localStorage.setItem(FOCUS_CTX_BROADCAST_KEY, JSON.stringify(ctx ?? null));
    } catch {
      /* storage 불가 환경 — follow 모드만 비활성 */
    }
  };
  publish(useStore.getState().focusCtx);
  return useStore.subscribe((s, prev) => {
    if (s.focusCtx !== prev.focusCtx) publish(s.focusCtx);
  });
}

/** 보조 창에서 방송을 구독 — 메인 창의 포커스 컨텍스트를 따라간다. */
export function useBroadcastFocusCtx(): FocusCtxSnapshot | null {
  const [ctx, setCtx] = useState<FocusCtxSnapshot | null>(() =>
    parseFocusCtxSnapshot(localStorage.getItem(FOCUS_CTX_BROADCAST_KEY)),
  );
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== FOCUS_CTX_BROADCAST_KEY) return;
      setCtx(parseFocusCtxSnapshot(event.newValue));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  return ctx;
}
