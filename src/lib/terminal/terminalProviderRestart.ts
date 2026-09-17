// Spaces 행의 재시작·계정 전환 액션.
//
// 등록된 에이전트는 restartRequests 카운터로 세션을 통째로 다시 만든다.
// 프로바이더가 감지된 터미널 행의 키 시퀀스 재시작은 legacy PTY/SSH 데몬
// 직접 write에 의존하던 경로였고, 그 런타임이 은퇴하면서(2026-08-16) 함께
// 제거됐다 — 터미널 행 재시작은 false를 돌려주고 아무것도 끊지 않는다.

import type { Provider } from "@/types";

/** 재시작·계정 전환이 알아야 하는 행의 최소 정보. */
export interface ProviderRowTarget {
  readonly key: string;
  readonly agentId?: string;
  readonly provider?: Provider | null;
  readonly sessionId?: string;
  readonly kind: "agent" | "term" | "ssh";
}

export interface ProviderRowActionDeps {
  readonly requestAgentRestart: (agentId: string) => void;
  readonly switchAgentCredential: (
    agentId: string,
    accountId: string | null,
    sourcePanelId: string,
  ) => Promise<void>;
  readonly setActiveAccount: (provider: Provider, accountId?: string) => void;
}

/**
 * 재시작 — 등록 에이전트는 세션을 통째로 다시 만든다(restartRequests).
 * 등록 레코드가 없는 터미널 행은 재시작 authority가 없어 false다.
 */
export async function restartProviderRow(
  row: ProviderRowTarget,
  deps: ProviderRowActionDeps,
): Promise<boolean> {
  if (row.agentId) {
    deps.requestAgentRestart(row.agentId);
    return true;
  }
  return false;
}

/**
 * 계정 전환 — 에이전트는 backend-owned runtime transition을 실행하고,
 * 일반 터미널만 그 프로바이더의 다음-launch 활성 계정을 바꾼다.
 */
export async function switchProviderRowAccount(
  row: ProviderRowTarget,
  accountId: string | null,
  deps: ProviderRowActionDeps,
): Promise<boolean> {
  if (row.agentId) {
    await deps.switchAgentCredential(
      row.agentId,
      accountId,
      row.key,
    );
    return true;
  }
  if (!row.provider) return false;
  deps.setActiveAccount(row.provider, accountId ?? undefined);
  return true;
}
