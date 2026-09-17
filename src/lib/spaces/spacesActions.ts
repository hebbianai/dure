// Spaces 컨텍스트 메뉴의 data-driven 정의 (P1-2).
// 메뉴 구조(항목·순서·표시 조건)를 데이터로 만들어 테스트하고, 렌더는
// SpacesPane이 이 목록을 그대로 그린다. 새 액션은 여기 배열에 추가한다.

import { t } from "@/lib/i18n";
import {
  hmuxManagedPromotionLabel,
  type HmuxManagedPromotionAvailability,
} from "@/lib/hmux/conversion/hmuxManagedPromotionEligibility";
import { providerForkInheritsConversation } from "@/lib/agents/providerForkCapability";
import { PROVIDERS, type Provider } from "@/types";

/** 계정 전환 절에 그릴 한 줄 — 시안 2092:16182의 "계정 전환" 목록. */
export interface SpaceMenuAccount {
  /** null이면 프로바이더 기본 계정 (별도 프로필 없이 쓰는 상태) */
  readonly id: string | null;
  readonly name: string;
  /** 지금 이 에이전트가 쓰는 계정이면 체크 표시 */
  readonly active: boolean;
}

/** 이동 서브메뉴가 아는 데스크탑 한 줄 — 스토어 Space의 부분집합. */
interface SpaceMenuDesktop {
  readonly id: string;
  readonly name: string;
  readonly kind?: "popout";
}

export interface SpaceMenuContext {
  /** 이번 액션이 적용될 세션 수 (선택 포함) */
  count: number;
  /** Existing desktop-scoped pin state for the single pane target. */
  pinned?: boolean;
  /** 이 행이 지금 속한 데스크탑 — 이동 대상에서 뺀다 */
  currentDesktopId?: string;
  /** 전체 데스크탑 목록 — popout·현재 데스크탑 필터는 메뉴가 소유한다 */
  desktops?: readonly SpaceMenuDesktop[];
  /** 로컬 Git 작업 경로 후보가 있는 단일 세션인가 */
  canViewDiff?: boolean;
  /** 등록된 에이전트 행인가 — 마지막 항목 문구('삭제' vs '종료')를 가른다 */
  isAgent?: boolean;
  /** 프로바이더가 돌고 있는가 (등록 에이전트 + 감지된 터미널).
   *  재시작·계정 전환은 '프로바이더가 도는 모든 행'에 있다 — 사용자에겐
   *  Claude를 띄운 터미널도 에이전트로 보인다. */
  hasProvider?: boolean;
  /** 이 에이전트 프로바이더로 쓸 수 있는 계정들 (단일 선택일 때만) */
  accounts?: readonly SpaceMenuAccount[];
  /** standalone provider pane의 managed 승격 힌트. 실제 inspection이 권위다. */
  managedPromotion?: HmuxManagedPromotionAvailability;
  /** 다중 선택 중 지금 승격 가능한 pane 수 */
  managedPromotionEligibleCount?: number;
  /** 다중 선택 중 후보지만 현재 상태를 유지할 pane 수 */
  managedPromotionDeferredCount?: number;
  provider?: Provider | null;
  /** 등록 에이전트 한 개를 새 worktree로 포크할 때 선택 가능한 provider. */
  forkProviders?: readonly Provider[];
}

export type SpaceMenuEntry =
  | { kind: "label"; id: string; label: string }
  | { kind: "separator"; id: string }
  | {
      /** 옆으로 열리는 하위 목록 — 렌더는 ContextMenuSub 계열이 맡는다. */
      kind: "submenu";
      id: string;
      label: string;
      entries: SpaceMenuEntry[];
    }
  | {
      kind: "item";
      id: string;
      label: string;
      variant?: "destructive";
      disabled?: boolean;
      action:
        | { type: "pin" | "unpin" }
        | { type: "view-diff" }
        | { type: "move-to-desktop"; desktopId: string }
        | { type: "move-to-new-desktop" }
        | { type: "restart" }
        | { type: "fork"; provider: Provider }
        | { type: "promote-managed" }
        | { type: "switch-account"; accountId: string | null }
        | { type: "kill" };
      /** 계정 줄의 체크 표시 — 선택된 계정에만 붙는다 */
      checked?: boolean;
    };

/** 컨텍스트 메뉴 전체를 데이터로 산출한다. 특정 데스크탑으로의 이동은
 *  드래그(제목/패널 영역 드롭)와 이동 서브메뉴 두 경로가 같은 의미를 갖는다 —
 *  이동할 다른 데스크탑이 없으면 새 데스크탑 항목만 평면으로 남는다. */
export function buildSpaceMenu(context: SpaceMenuContext): SpaceMenuEntry[] {
  // 단일 선택에는 제목을 두지 않는다 (시안 2092:16182에도 없다) — 우클릭한
  // 행이 이미 하이라이트돼 있어서 무엇에 대한 메뉴인지 한 번 더 말할 필요가
  // 없다. 다중 선택은 다르다: 몇 개에 적용되는지는 행 하이라이트만으로
  // 세기 어렵고, 마지막 항목이 파괴적이라 범위를 먼저 보여줘야 한다.
  const entries: SpaceMenuEntry[] =
    context.count > 1
      ? [{ kind: "label", id: "header", label: t("spaces.actions.sessionCount", { n: context.count }) }]
      : [];
  if (context.count === 1 && context.pinned !== undefined) {
    entries.push({
      kind: "item",
      id: "pin",
      label: context.pinned ? t("workspace.paneMenu.unpin") : t("workspace.paneMenu.pin"),
      action: { type: context.pinned ? "unpin" : "pin" },
    });
  }
  // Restart resumes the agent's existing conversation.
  if (context.hasProvider && context.count === 1) {
    entries.push({
      kind: "item",
      id: "restart",
      label: t("spaces.actions.restartAgent"),
      action: { type: "restart" },
    });
  }
  if (
    context.isAgent &&
    context.count === 1 &&
    context.provider &&
    (context.forkProviders?.length ?? 0) > 0
  ) {
    entries.push({
      kind: "label",
      id: "fork-title",
      label: t("common.sessionForkNewWorktree"),
    });
    for (const provider of context.forkProviders ?? []) {
      entries.push({
        kind: "item",
        id: `fork:${provider}`,
        label: t("spaces.actions.forkTo", {
          provider: PROVIDERS[provider].label,
          mode: providerForkInheritsConversation(context.provider, provider)
            ? t("common.conversationFork")
            : t("common.newConversation"),
        }),
        action: { type: "fork", provider },
      });
    }
    entries.push({ kind: "separator", id: "sep-fork" });
  }
  if (
    context.count === 1 &&
    context.managedPromotion &&
    context.managedPromotion !== "hidden"
  ) {
    entries.push({
      kind: "item",
      id: "promote-managed",
      label: hmuxManagedPromotionLabel(
        context.managedPromotion,
        context.provider,
      ),
      action: { type: "promote-managed" },
      disabled: context.managedPromotion !== "eligible",
    });
  } else if (
    context.count > 1 &&
    ((context.managedPromotionEligibleCount ?? 0) > 0 ||
      (context.managedPromotionDeferredCount ?? 0) > 0)
  ) {
    const eligible = context.managedPromotionEligibleCount ?? 0;
    entries.push({
      kind: "item",
      id: "promote-managed",
      label:
        eligible > 0
          ? t("spaces.managed.convertCount", { n: eligible })
          : t("spaces.managed.unavailable"),
      action: { type: "promote-managed" },
      disabled: eligible === 0,
    });
  }
  // 다중선택이 아닌 단일 로컬 세션에서만 하나의 worktree diff를 연다.
  if (context.canViewDiff && context.count === 1) {
    entries.push({
      kind: "item",
      id: "view-diff",
      label: t("spaces.actions.viewDiff"),
      action: { type: "view-diff" },
    });
    entries.push({ kind: "separator", id: "sep-diff" });
  }
  // 이동 대상 판정은 메뉴가 소유한다: popout은 원본의 위성이라 이동 대상이
  // 아니고, 현재 데스크탑으로의 "이동"은 무의미하다. 대상이 있으면 드래그와
  // 같은 의미의 서브메뉴, 없으면 기존 평면 '새 데스크탑으로 이동'.
  const moveTargets = (context.desktops ?? []).filter(
    (desktop) =>
      desktop.kind !== "popout" && desktop.id !== context.currentDesktopId,
  );
  if (moveTargets.length > 0) {
    entries.push({
      kind: "submenu",
      id: "move",
      label: t("spaces.desktop.moveToDesktop"),
      entries: [
        ...moveTargets.map(
          (desktop): SpaceMenuEntry => ({
            kind: "item",
            id: `move-to:${desktop.id}`,
            label: desktop.name,
            action: { type: "move-to-desktop", desktopId: desktop.id },
          }),
        ),
        { kind: "separator", id: "sep-move-new" },
        {
          kind: "item",
          id: "move-new",
          label: t("common.newDesktop"),
          action: { type: "move-to-new-desktop" },
        },
      ],
    });
  } else {
    entries.push({
      kind: "item",
      id: "move-new",
      label: t("spaces.desktop.moveToNew"),
      action: { type: "move-to-new-desktop" },
    });
  }
  // 계정 전환 — 시안의 가운데 절. 계정이 둘 이상일 때만 의미가 있다
  // (하나뿐이면 고를 게 없다). 잔량 %는 시안에 있지만 아직 데이터가 없다:
  // usage_recent는 프로바이더 단위 집계라 계정별로 쪼갤 수 없다.
  const accounts = context.accounts ?? [];
  if (context.hasProvider && context.count === 1 && accounts.length > 1) {
    entries.push({ kind: "separator", id: "sep-accounts" });
    entries.push({ kind: "label", id: "accounts-title", label: t("spaces.actions.switchAccount") });
    for (const account of accounts) {
      entries.push({
        kind: "item",
        id: `account:${account.id ?? "default"}`,
        label: account.name,
        checked: account.active,
        action: { type: "switch-account", accountId: account.id },
      });
    }
  }
  entries.push({ kind: "separator", id: "sep-kill" });
  entries.push({
    kind: "item",
    id: "kill",
    // 에이전트는 세션만 끊는 게 아니라 워크트리·등록까지 함께 정리된다.
    label:
      context.count > 1
        ? t("spaces.kill.sessions", { n: context.count })
        : context.isAgent
          ? t("common.deleteAgent")
          : t("spaces.kill.session"),
    variant: "destructive",
    action: { type: "kill" },
  });
  return entries;
}
