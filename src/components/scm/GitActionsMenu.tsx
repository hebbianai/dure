// 저장소 git 액션 메뉴 — SourceControlPane에서 추출(god-file 다이어트).
//
// 결과 표시는 메뉴 밖에서 한다: Radix는 항목 클릭 즉시 메뉴를 언마운트하므로
// 메뉴 안에 그린 에러는 아무도 못 본다(2026-08-01 UX 검수에서 확인된 무음
// 실패). 실패는 네이티브 다이얼로그, 성공은 토스트로 알린다.
import type { ReactNode } from "react";
import { confirm as confirmDialog, message as messageDialog } from "@tauri-apps/plugin-dialog";
import { useStore } from "@/store";
import { t } from "@/lib/i18n";
import type { Project } from "@/types";
import { gitAction } from "@/lib/scm/history/git";
import { openGitPanel } from "@/lib/workspace/dock/openScmPanel";
import { showToast } from "@/lib/toast";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";

/** 저장소 git 액션 메뉴 (VS Code SCM ⋯ — Figma 378-18803). onRun 후 새로고침 콜백.
 *
 *  `children`은 git 액션들 위에 먼저 놓인다. 커밋 변형(Amend·Signed Off 등)처럼
 *  초안 메시지가 있어야 뜻이 서는 항목을 위한 자리다 — 그 초안은 카드가 들고
 *  있으므로 여기로 끌어오면 이 메뉴가 project 하나로 서는 성질을 잃는다.
 *  호출 쪽이 항목을 만들어 넣고, 이 파일은 여전히 project만 안다. */
export function GitActionsMenu({
  project,
  onDone,
  align = "end",
  children,
}: {
  project: Project;
  onDone?: () => void;
  align?: "start" | "end";
  children?: ReactNode;
}) {
  const run = async (args: string[], label: string) => {
    try {
      // gitAction은 git 실패를 문자열로 돌려주지만, IPC 자체가 거부되면
      // reject다 — 둘 다 다이얼로그로 모아 무음 실패 경로를 남기지 않는다.
      const e = await gitAction(project, args).catch((error) => String(error));
      if (e) {
        await messageDialog(t("scm.actions.failed", { action: label, error: e }), {
          title: t("Git"),
          kind: "error",
        });
      } else {
        showToast(t("scm.actions.done", { action: label }));
      }
    } finally {
      onDone?.();
    }
  };
  // 원격/스태시를 덮어쓰는 액션은 실행 전에 결과를 말하고 확인을 받는다 —
  // 되돌릴 수 있는 UI 상태(고정 pane)엔 확인이 있으면서 저장소 이력엔 없던
  // 정책 역전을 바로잡는다.
  const runGuarded = async (args: string[], label: string, warning: string) => {
    const ok = await confirmDialog(warning, { title: label, kind: "warning" });
    if (ok) await run(args, label);
  };
  return (
    <DropdownMenuContent align={align} className="w-52">
      {children && (
        <>
          {children}
          <DropdownMenuSeparator />
        </>
      )}
      <DropdownMenuItem onClick={() => void run(["pull", "--ff-only"], t("scm.actions.pull"))}>
        <span className="text-xs">{t("scm.actions.pull")}</span>
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => void run(["push"], t("scm.actions.push"))}>
        <span className="text-xs">{t("scm.actions.push")}</span>
      </DropdownMenuItem>
      <DropdownMenuItem
        onClick={() => void run(["fetch", "--all", "--prune"], t("scm.actions.fetch"))}
      >
        <span className="text-xs">{t("scm.actions.fetch")}</span>
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          <span className="text-xs">{t("scm.actions.pullPush")}</span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          <DropdownMenuItem
            onClick={() => void run(["pull", "--rebase"], t("scm.actions.pullRebase"))}
          >
            <span className="text-xs">{t("scm.actions.pullRebase")}</span>
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() =>
              void runGuarded(
                ["push", "--force-with-lease"],
                t("scm.actions.forcePush.title"),
                t("scm.actions.forcePush.confirm"),
              )
            }
          >
            <span className="text-xs">{t("scm.actions.forcePush.menu")}</span>
          </DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          <span className="text-xs">{t("scm.actions.stash.menu")}</span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          <DropdownMenuItem
            onClick={() => void run(["stash", "push", "-u"], t("scm.actions.stash.save"))}
          >
            <span className="text-xs">{t("scm.actions.stash.save")}</span>
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() =>
              void runGuarded(
                ["stash", "pop"],
                t("scm.actions.stash.popTitle"),
                t("scm.actions.stash.popConfirm"),
              )
            }
          >
            <span className="text-xs">{t("scm.actions.stash.pop")}</span>
          </DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        onClick={() =>
          openGitPanel(useStore.getState().activeSpaceId, project.id, project.name)
        }
      >
        <span className="text-xs">{t("scm.actions.showGitOutput")}</span>
      </DropdownMenuItem>
    </DropdownMenuContent>
  );
}
