/**
 * 로그인 credential 정체성(이메일·플랜) 조회 훅 — 팝오버가 열릴 때만 마운트되는
 * 위치에서 쓰고, 같은 대상은 60초 캐시로 IPC 왕복을 아낀다. 계정 전환/재로그인
 * 반영은 캐시 만료로 충분하다(표시용 정보).
 */
import { useEffect, useState } from "react";
import { accountLoginIdentity, type AccountLoginIdentity } from "@/lib/ipc";
import type { Provider } from "@/types";

// 짧게 둔다: 같은 dir에 재로그인하면(계정 전환이 아니라 로그인 교체) 키가
// 그대로라 캐시가 이전 이메일을 보여줄 수 있다 — 표시용이므로 TTL로 자가
// 치유하되 그 창을 20초로 제한한다.
const TTL_MS = 20_000;
const cache = new Map<string, { at: number; value: AccountLoginIdentity }>();

/** null = 아직 조회 전(또는 실패). dir 미지정 = 시스템 기본 로그인. */
export function useLoginIdentity(
  provider: Provider,
  dir: string | undefined,
): AccountLoginIdentity | null {
  const [identity, setIdentity] = useState<AccountLoginIdentity | null>(null);
  useEffect(() => {
    const key = `${provider}|${dir ?? ""}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) {
      setIdentity(hit.value);
      return;
    }
    let stale = false;
    setIdentity(null);
    accountLoginIdentity(provider, dir)
      .then((value) => {
        cache.set(key, { at: Date.now(), value });
        if (!stale) setIdentity(value);
      })
      .catch(() => {
        /* 표시용 — 실패는 조용히 미표시 */
      });
    return () => {
      stale = true;
    };
  }, [provider, dir]);
  return identity;
}
