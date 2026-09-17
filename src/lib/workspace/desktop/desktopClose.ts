// 데스크탑 닫기 확인+실행 플로우 — DesktopBar 탭의 X 버튼과 Spaces 그룹
// 우클릭 메뉴가 같은 카피·같은 안전장치(세션 종료 계획 고지, 실패 시 유지)를
// 쓰도록 한 곳에 둔다.
import { confirm as confirmDialog, message as messageDialog } from "@tauri-apps/plugin-dialog";
import { planDesktopRemoval, removeDesktopWithSessions } from "@/lib/workspace/desktop/desktopLifecycle";
import { t } from "@/lib/i18n";

/** 확인 다이얼로그 후 데스크탑을 닫는다. 닫았으면 true. */
export async function confirmAndCloseDesktop(desktopId: string, name: string): Promise<boolean> {
  const plan = planDesktopRemoval(desktopId);
  const sessionCopy =
    plan.terminate.length > 0
      ? t("workspace.desktopClose.terminatesSessions", {
          n: plan.terminate.length,
        })
      : t("workspace.desktopClose.noSessionsToTerminate");
  const sharedCopy =
    plan.preserveShared.length > 0
      ? `\n${t("workspace.desktopClose.sharedSessionsKept", {
          n: plan.preserveShared.length,
        })}`
      : "";
  const ok = await confirmDialog(
    `${t("workspace.desktopClose.confirm", { name })}\n${sessionCopy}${sharedCopy}`,
    { title: t("common.closeDesktop"), kind: "warning" },
  );
  if (!ok) return false;
  try {
    await removeDesktopWithSessions(desktopId);
    return true;
  } catch (error) {
    await messageDialog(
      t("workspace.desktopClose.terminateFailed", {
        error: String(error),
      }),
      { title: t("workspace.desktopClose.failedTitle"), kind: "error" },
    );
    return false;
  }
}
