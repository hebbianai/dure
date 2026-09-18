import { useState } from "react";
import { Plus, RefreshCw } from "lucide-react";
import { t } from "@/lib/i18n";
import { openFileViewer } from "@/lib/files/fileViewerPane";
import { runWorkspaceCommand } from "@/lib/workspace/workspaceCommand";
import { FileTree } from "@/components/files/FileTree";
import { NewFolderIcon } from "@/components/sidebar/NewFolderIcon";
import { RecentFileOpensSection } from "@/components/sidebar/RecentFileOpensSection";
import { useRecentFileOpens } from "@/lib/files/recentFileOpensStore";
import { SectionHeaderRow, SidebarGroupLabel } from "@/components/sidebar/SidebarItems";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { createEntryCommand, filesPaneTitle } from "@/lib/files/filesPane";
import { cn } from "@/lib/utils";
import { SEARCH_FIELD_SURFACE, SEARCH_FIELD_TEXT } from "@/lib/ui/searchField";
import { useFilesPaneState } from "@/components/files/useFilesPaneState";
import { PaneEmptyState } from "@/components/common/PaneEmptyState";

/** 파일 탭 — 포커스한 패널의 작업 폴더를 트리로 (오른쪽 탐색기와 동일 소스) */
export function FilesPane() {
  const hasRecentFiles = useRecentFileOpens((state) => state.entries.length > 0);
  const { focus, projects, currentSpaceId } = useFilesPaneState();
  const [reloadKey, setReloadKey] = useState(0);
  const [creating, setCreating] = useState<null | "file" | "dir">(null);
  const [newName, setNewName] = useState("");
  const [createErr, setCreateErr] = useState<string | null>(null);

  const openFile = (path: string) => {
    openFileViewer(currentSpaceId(), {
      path,
      source: focus?.source ?? "local",
      hostId: focus?.hostId,
    });
  };

  const startCreate = (kind: "file" | "dir") => {
    if (!focus) return;
    setCreating(kind);
    setNewName("");
    setCreateErr(null);
  };

  const submitCreate = async () => {
    if (!focus || !creating) return;
    const name = newName.trim();
    if (!name) {
      setCreating(null);
      return;
    }
    const cmd = createEntryCommand(focus.cwd, name, creating);
    try {
      const r = await runWorkspaceCommand(focus, cmd);
      if (r.code !== 0) {
        setCreateErr(r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`);
        return;
      }
      setCreating(null);
      setReloadKey((k) => k + 1);
    } catch (e) {
      setCreateErr(String(e));
    }
  };

  const title = filesPaneTitle(focus, projects);

  // 2391:44372 — 패널 제목 줄 "File". 액션은 새로고침·새 폴더·새 파일 순이고
  // 글리프는 RefreshCw / NewFolderIcon / Plus다(스페이스 탭 머리행과 같은 24px
  // 박스 + 14px 아이콘). 가운데는 lucide FolderPlus가 아니다 — 시안은 더하기를
  // 폴더 안이 아니라 왼쪽 모서리에 걸치는 별도 글리프를 쓴다(RailIcons 주석).
  // 포커스가 없으면 지울 게 아니라 눌리지 않게 둔다 — 사라지면 이 탭이 무엇을
  // 할 수 있는 곳인지 빈 화면에서 알 수 없다.
  const header = (
    <SectionHeaderRow
      as="h2"
      className="shrink-0"
      label={t("common.file")}
      // 시안에는 트리 루트를 말하는 줄이 없다. 줄을 새로 만들지 않고 툴팁으로만
      // 남긴다 — 포커스한 pane에 따라 루트가 바뀌므로 어딘가에는 있어야 한다.
      actions={
        <>
          <IconButton
            title={t("common.refresh")}
            showTooltip={false}
            disabled={!focus}
            onClick={() => setReloadKey((k) => k + 1)}
          >
            <RefreshCw />
          </IconButton>
          <IconButton
            title={t("sidebar.files.newFolder")}
            disabled={!focus}
            onClick={() => startCreate("dir")}
          >
            <NewFolderIcon />
          </IconButton>
          <IconButton
            title={t("sidebar.files.newFile")}
            disabled={!focus}
            onClick={() => startCreate("file")}
          >
            <Plus />
          </IconButton>
        </>
      }
    />
  );

  return (
    // min-w-0이 없으면 최소 너비에서 헤더가 옆으로 넘쳐 오른쪽 패딩이 사라진다
    <div className="flex min-h-0 min-w-0 flex-1 flex-col pt-1.5">
      {header}
      {/* 트리 루트는 시안에 줄이 없어 제목 줄 툴팁으로 옮겼는데, title은
          키보드·보조기술로는 닿지 않는다. 같은 사실을 보이지 않는 한 줄로도
          내보낸다 — 화면은 시안 그대로고 낭독만 늘어난다. */}
      {focus && (
        <p className="sr-only">
          {t("sidebar.files.currentFolder")}: {title ?? focus.cwd}
        </p>
      )}
      {creating && (
        <div className="shrink-0 px-3 pt-1.5">
          <Input
            autoFocus
            className={cn(
              "h-6 rounded-md px-2",
              SEARCH_FIELD_SURFACE,
              SEARCH_FIELD_TEXT,
            )}
            placeholder={creating === "dir" ? t("sidebar.files.newFolderName") : t("sidebar.files.newFileName")}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submitCreate();
              if (e.key === "Escape") setCreating(null);
            }}
            onBlur={() => {
              if (!newName.trim()) setCreating(null);
            }}
          />
          {createErr && (
            <div className="px-1 pt-1 text-meta break-all text-destructive">{createErr}</div>
          )}
        </div>
      )}
      {focus ? (
        <FileTree
          // 루트가 바뀌어도 리마운트하지 않는다 — 트리가 펼침·스크롤·선택을 루트별로
          // 기억하므로, 포커스를 옮겼다 돌아오면 보던 상태 그대로다.
          // 새로고침(reloadKey)일 때만 다시 마운트해 캐시된 폴더 내용을 버린다.
          key={reloadKey}
          cwd={focus.cwd}
          source={focus.source}
          hostId={focus.hostId}
          onOpenFile={openFile}
          // 시안 순서: 검색 → 최근 파일 → 구분선 → 트리.
          beforeTree={
            <>
              <RecentFileOpensSection />
              {/* The tree carries its own group label (Figma 3404:86362), which
                  replaces the hairline that used to separate it from the recent
                  list — a label and a rule both mark the same boundary, and the
                  comp draws only the label. */}
              <SidebarGroupLabel className="mt-2">{t("sidebar.files.allFiles")}</SidebarGroupLabel>
            </>
          }
        />
      ) : (
        /* The same 8px inset the tree's viewport gives these sections when a
           folder is showing; without it the recent list sat 8px further out
           than in every other state (owner report 2026-09-09). */
        <div className="px-2">
          {/* 최근 파일 — 포커스 컨텍스트와 무관하게 항상(사용자 요청) */}
          <RecentFileOpensSection />
          {/* Section-empty vs pane-empty (the rule the ssh tab set, 2026-09-08):
              with recent files above, only the tree section is empty, so the
              hint sits under the tree's own label like any section notice
              — the centred shape floating mid-pane under a list read as
              misplaced (owner report 2026-09-09). With nothing above, the
              pane is empty and takes the centred shape. */}
          {hasRecentFiles ? (
            <>
              <SidebarGroupLabel className="mt-2">{t("sidebar.files.allFiles")}</SidebarGroupLabel>
              <p className="px-2 py-1 text-xs text-muted-foreground" role="status">
                {t("sidebar.files.selectPanelHint")}
              </p>
            </>
          ) : (
            <PaneEmptyState
              compact
              title={t("sidebar.files.selectPanelHint")}
            />
          )}
        </div>
      )}
    </div>
  );
}
