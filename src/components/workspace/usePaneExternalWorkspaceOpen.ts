import { useEffect, useState } from "react";
import { t } from "@/lib/i18n";
import type { ExternalOpenTarget } from "@/lib/ipc/externalWorkspace";
import { showErrorToast, showToast } from "@/lib/toast";
import {
  loadExternalOpenTargets,
  openExternalWorkspaceForPane,
} from "@/lib/workspace/externalWorkspace";

/** Keeps native catalog loading and launch feedback out of every pane header. */
export function usePaneExternalWorkspaceOpen({
  menuOpen,
  panelId,
  spaceId,
}: {
  menuOpen: boolean;
  panelId: string;
  spaceId: string | undefined;
}) {
  const [targets, setTargets] = useState<readonly ExternalOpenTarget[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!menuOpen || loaded) return;
    let live = true;
    void loadExternalOpenTargets()
      .then((catalog) => {
        if (!live) return;
        setTargets(catalog);
        setLoaded(true);
      })
      .catch((error) => {
        if (!live) return;
        showErrorToast(
          t("workspace.externalOpen.listFailed", {
            error: error instanceof Error ? error.message : String(error),
          }),
          { paneId: panelId },
        );
      });
    return () => {
      live = false;
    };
  }, [loaded, menuOpen]);

  const open = spaceId
    ? async (targetId: string) => {
        try {
          const receipt = await openExternalWorkspaceForPane({
            spaceId,
            panelId,
            targetId,
          });
          const target = targets.find((candidate) => candidate.id === receipt.targetId);
          showToast(
            t("workspace.externalOpen.opened", {
              target: target?.label ?? receipt.targetId,
            }),
            { paneId: panelId },
          );
        } catch (error) {
          showErrorToast(
            t("workspace.externalOpen.failed", {
              error: error instanceof Error ? error.message : String(error),
            }),
            { paneId: panelId },
          );
        }
      }
    : undefined;

  return { open, targets };
}
