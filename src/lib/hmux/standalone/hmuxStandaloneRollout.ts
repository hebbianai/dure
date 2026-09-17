import { BACKEND_FEATURES, backendSupports } from "@/lib/ipc";
import { LEGACY_PRODUCT_COMPATIBILITY } from "@/lib/platform/legacyProductCompatibility";

/** 새 로컬 터미널을 legacy로 되돌리는 비상 스위치. 켜면(=1) 예전 PTY 경로를 쓴다. */
export const HMUX_STANDALONE_OPT_OUT_KEY = "dure.hmuxStandaloneOptOut.v1";

/** 이미 떠 있는 세션은 자기 런타임으로 계속 산다 — 이 스위치는 "새로 만드는" 것만 가른다. */
export function hmuxStandaloneOptedOut(): boolean {
  const canonicalEnvironment = import.meta.env.VITE_DURE_HMUX_STANDALONE;
  const legacyEnvironment = (
    import.meta.env as unknown as Record<string, string | undefined>
  )[LEGACY_PRODUCT_COMPATIBILITY.hmuxStandaloneEnvironmentKey];
  if (
    canonicalEnvironment !== undefined
      ? canonicalEnvironment === "0"
      : legacyEnvironment === "0"
  ) return true;
  try {
    const canonicalStorage = localStorage.getItem(HMUX_STANDALONE_OPT_OUT_KEY);
    return canonicalStorage !== null
      ? canonicalStorage === "1"
      : localStorage.getItem(
          LEGACY_PRODUCT_COMPATIBILITY.hmuxStandaloneOptOutStorageKey,
        ) === "1";
  } catch {
    return false;
  }
}

/** 새 로컬 터미널을 Hmux로 띄울 수 있는지 — 비상 스위치 + 백엔드 지원 확인.
 *  false면 호출부가 legacy PTY로 만든다(구버전 백엔드에서도 터미널은 열려야 하므로). */
export async function hmuxStandaloneReady(): Promise<boolean> {
  if (hmuxStandaloneOptedOut()) return false;
  return backendSupports(BACKEND_FEATURES.hmuxStandaloneTerminalSurface);
}

/** Current Dure backends can create an ordinary shell directly in the managed
 * controller posture. The existing emergency opt-out still disables every
 * Hmux-backed default shell and falls back to the legacy PTY path. */
export async function hmuxManagedShellReady(): Promise<boolean> {
  if (hmuxStandaloneOptedOut()) return false;
  return backendSupports(BACKEND_FEATURES.hmuxManagedShell);
}

/** 같은 자리(key)에 대한 생성 요청을 하나로 합친다.
 *  React StrictMode는 마운트 effect를 두 번 돌리는데, Hmux 세션 id는 호스트가
 *  만들어주므로 legacy처럼 결정적 id로 합칠 수가 없다 — 진행 중인 생성 약속을
 *  재사용해 프로바이더가 두 개 뜨는 것을 막는다. */
const inFlight = new Map<string, Promise<unknown>>();
const SETTLED_GRACE_MS = 5000;

export function createStandaloneOnce<T>(key: string, run: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const started = run();
  inFlight.set(key, started);
  // 성공한 생성은 잠시 더 들고 있는다 — 두 번째 마운트가 약속이 끝난 뒤에 와도
  // 같은 세션을 재사용하도록. 실패는 즉시 비워 재시도를 막지 않는다.
  void started.then(
    () => setTimeout(() => inFlight.delete(key), SETTLED_GRACE_MS),
    () => inFlight.delete(key),
  );
  return started;
}

/** 테스트·재시작용 — 진행 중 기록을 비운다. */
export function resetStandaloneCreateTracking() {
  inFlight.clear();
}
