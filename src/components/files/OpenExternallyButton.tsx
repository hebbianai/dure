import { ExternalLink } from "lucide-react";
import { openPath } from "@tauri-apps/plugin-opener";
import { t } from "@/lib/i18n";
import { showToast } from "@/lib/toast";

/** 로컬 파일을 OS 기본 앱으로 연다 — 뷰어가 못 여는/잘린 매체의 탈출구. */
export function OpenExternallyButton({ path, paneId }: { path: string; paneId?: string }) {
  return (
    <button
      type="button"
      className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
      onClick={() => {
        void openPath(path).catch(() =>
          showToast(
            t("common.openFailedPathMissing"),
            paneId ? { paneId } : undefined,
          ),
        );
      }}
    >
      <ExternalLink className="size-3" />
      {t("panels.fileViewer.openInDefaultApp")}
    </button>
  );
}
