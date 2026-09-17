import { OverflowRevealText } from "@/components/ui/overflow-reveal-text";
import {
  type DragEvent as ReactDragEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { Folder, FolderOpen, Trash2 } from "lucide-react";
import { DureLoader } from "@/components/ui/dure-loader";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { InlineConfirmRow } from "@/components/ui/inline-confirm";
import { FileGlyph } from "@/components/sidebar/FileGlyph";
import {
  hostToOpts,
  saveFilesToDirectory,
  sshDeleteFile,
  type DirEntry,
  uploadSshFilesToDirectory,
} from "@/lib/ipc";
import { useFileTreeState, findFileHost, discardDeletedFileDrafts } from "@/components/files/useFilesPaneState";
import { useDirectoryListing } from "@/components/files/useDirectoryListing";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import { DisclosureChevron } from "@/components/ui/disclosure-chevron";
import { ErrorText } from "@/components/ui/error-text";
import { SearchField } from "@/components/ui/search-field";
import { SidebarScrollArea } from "@/components/ui/scroll-area";
import { useSidebarScrollMemory } from "@/components/sidebar/useSidebarScrollMemory";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { fileTreeKey, isExpanded } from "@/lib/files/fileTreeExpansion";
import { useFileTreeExpansion } from "@/lib/files/fileTreeExpansionStore";
import { shareFileAtPointer } from "@/lib/platform/share";
import { encodeDureDragPayload } from "@/lib/platform/productDragPayload";
import { detectDesktopPlatform } from "@/lib/workspace/desktop/desktopPlatform";
import { fileTreeContextActions } from "@/lib/files/fileTreeContextActions";
import {
  buildFileTreeSearchCommand,
  FILE_TREE_SEARCH_LIMIT,
  type FileTreeSearchResult,
  parseFileTreeSearchResults,
} from "@/lib/files/fileTreeSearch";
import { runWorkspaceCommand } from "@/lib/workspace/workspaceCommand";
import {
  isExternalFileDrag,
  prepareDroppedFilePayloads,
} from "@/lib/files/externalFileDrop";
import { describeFileTreeFileDropError } from "@/lib/files/fileTreeFileDrop";
import { publishFileDeletion } from "@/lib/files/fileDeletionEvents";
import { showErrorToast, showToast } from "@/lib/toast";

interface Ctx {
  source: "local" | "ssh";
  hostId?: string;
  /** 펼침 상태 저장 키 — 같은 cwd·소스·호스트면 리마운트해도 동일 */
  expansionKey: string;
  showGitIgnored: boolean;
}

interface FileTreeSearchState {
  key: string;
  loading: boolean;
  results: FileTreeSearchResult[];
  error: string | null;
}

const desktopPlatform = detectDesktopPlatform();

/** One file-tree row — Figma 3404:86362 "Sidebar / SidebarMenuButton": a fixed
 *  32px row, 8px padding, 8px gap, 8px radius, 14px icons and the 13px label.
 *  Indents 12px per depth, and a file — which draws no chevron — takes the
 *  chevron's 22px slot as extra so its icon lands in the folder icon's column.
 *  Hidden files render at 50% opacity. */
function TreeNode({
  entry,
  depth,
  ctx,
  selected,
  refreshRevision,
  dropTarget,
  dropPending,
  onOpenFile,
  onExternalDragOver,
  onExternalDrop,
  deletingPath,
  onDeleteRemote,
  deleteConfirmPath,
  onDeleteConfirm,
  onDeleteCancel,
}: {
  entry: DirEntry;
  depth: number;
  ctx: Ctx;
  selected?: string;
  refreshRevision: number;
  dropTarget: string | null;
  dropPending: string | null;
  onOpenFile: (path: string) => void;
  onExternalDragOver: (path: string, event: ReactDragEvent<HTMLElement>) => void;
  onExternalDrop: (path: string, event: ReactDragEvent<HTMLElement>) => void;
  deletingPath: string | null;
  onDeleteRemote: (entry: DirEntry) => void;
  /** Path armed for in-place delete confirmation (SOUL §6 — no popup). */
  deleteConfirmPath: string | null;
  onDeleteConfirm: (entry: DirEntry) => void;
  onDeleteCancel: () => void;
}) {
  const { source, hostId, expansionKey, showGitIgnored } = ctx;
  // 펼침은 스토어가 소유한다 — 포커스가 바뀌어 트리가 다시 그려져도 살아남는다.
  const open = useFileTreeExpansion(
    (s) => entry.isDir && isExpanded(s, expansionKey, entry.path),
  );
  const toggleExpansion = useFileTreeExpansion((s) => s.toggle);
  const { entries: children, loading, error: loadError, reload } = useDirectoryListing(
    { path: entry.path, source, hostId, showGitIgnored },
    refreshRevision,
    open,
  );
  const hidden = entry.name.startsWith(".");
  const contextActions = fileTreeContextActions({
    source,
    isDirectory: entry.isDir,
    platform: desktopPlatform,
  });

  const toggle = () => {
    if (!entry.isDir) {
      onOpenFile(entry.path);
      return;
    }
    toggleExpansion(expansionKey, entry.path);
  };

  // Two different numbers, which is the point. 22px is the *slot* a chevron
  // and its gap occupy, so a file — which has no chevron — takes that much
  // extra and its icon lands in the folder icon's column. 12px is the *step*
  // per level, and the two used to be the same value: at 22px a step, a node
  // four deep spent 118px of a 250px pane on indentation and every name
  // truncated (owner report 2026-09-08). A shipping IDE keeps them apart the
  // same way — `Math.max(22 - indent, 0)` in its tree code, with the indent
  // setting defaulting to 8. We take 12 rather than 8 because it draws indent
  // guides down each level and we do not, so the step has to carry the nesting
  // on its own.
  //
  // The 8px base is the row's own inset; the viewport pads the other 8, so a
  // depth-0 label stands 16px from the pane edge while the row's fill stops
  // 8px short of it.
  const indent = 8 + depth * 12;

  // Hover and selection lift the row with a translucent white tint, never an
  // opaque darker fill: on a sidebar that is the window's NSVisualEffectView
  // showing through, an opaque fill punches a hole in the glass, and in dark
  // mode a layer rises by gaining light, not by losing it. `sidebar-accent` was
  // the opaque holdout — every other sidebar list already used the glass tints
  // (owner report 2026-09-08, the file tab darkening where the space tab
  // brightened).
  const row = (
    <button type="button"
      className={cn(
        "group/label flex h-8 w-full items-center gap-2 rounded-md pr-2 text-left text-xs leading-none text-sidebar-foreground hover:bg-glass-tint-hover",
        hidden && "opacity-50",
        selected === entry.path && "bg-glass-tint-selected",
        entry.isDir && dropTarget === entry.path &&
          "bg-primary/10 text-sidebar-accent-foreground inset-ring-1 inset-ring-primary/40",
        entry.isDir && dropPending === entry.path && "opacity-70",
      )}
      style={{ paddingLeft: indent }}
      onClick={toggle}
      data-file-drop-target={entry.isDir ? entry.path : undefined}
      aria-busy={
        (entry.isDir && dropPending === entry.path) || deletingPath === entry.path
          ? true
          : undefined
      }
      onDragOver={(event) => {
        if (entry.isDir) onExternalDragOver(entry.path, event);
      }}
      onDrop={(event) => {
        if (entry.isDir) onExternalDrop(entry.path, event);
      }}
      // 패널 영역으로 끌어다 놓으면 그 위치에 pane을 연다 — 파일은 뷰어,
      // 폴더는 그 cwd의 터미널. Sidebar 드래그와 같은 페이로드 계약이고,
      // 드롭 위치가 마땅치 않으면 Workspace가 떠 있는 pane으로 폴백한다.
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData(
          "text/plain",
          encodeDureDragPayload({
            type: "file",
            path: entry.path,
            isDir: entry.isDir,
            source,
            ...(hostId ? { hostId } : {}),
          }),
        );
        event.dataTransfer.effectAllowed = "copyMove";
      }}
    >
      {/* The folder mark is the column an eye runs down when it scans a tree,
          so it sits a step above the file glyph and the chevron: brightness
          here tracks whether a mark is worth scanning, not how important it is
          (owner call 2026-09-08). The file glyph stays muted because it is the
          same lucide `File` for every extension and so has nothing to scan by,
          and the chevron stays muted because a control is looked for rather
          than noticed. */}
      {entry.isDir ? (
        <>
          {open ? (
            <FolderOpen className="size-3.5 shrink-0 text-sidebar-foreground/70" />
          ) : (
            <Folder className="size-3.5 shrink-0 text-sidebar-foreground/70" />
          )}
        </>
      ) : (
        <FileGlyph />
      )}
      <OverflowRevealText className="flex-1" text={entry.name} />
      {/* The fold chevron stands after the name and shows while the row is
          hovered — the one chevron idiom of every sidebar folder row (owner
          call 2026-09-10). It used to lead the row, and files indented 22px to
          clear it; folders and files now share one indent. */}
      {entry.isDir && <DisclosureChevron hint open={open} />}
      {((entry.isDir && dropPending === entry.path) || deletingPath === entry.path) && (
        <DureLoader decorative className="shrink-0 text-muted-foreground" />
      )}
    </button>
  );

  if (deleteConfirmPath === entry.path) {
    // The armed row swaps to the in-place confirm (SOUL §6); the subtree
    // below an armed folder stays visible so the user sees what goes.
    return (
      <InlineConfirmRow
        question={t(
          entry.isDir
            ? "sidebar.fileTree.deleteRemote.confirmFolder"
            : "sidebar.fileTree.deleteRemote.confirmFile",
          { name: entry.name },
        )}
        confirmLabel={t("sidebar.fileTree.deleteRemote.confirmLabel")}
        busy={deletingPath === entry.path}
        onConfirm={() => onDeleteConfirm(entry)}
        onCancel={onDeleteCancel}
      />
    );
  }

  return (
    <>
      {contextActions.length > 0 ? (
        // 로컬은 OS 액션, SSH는 provider 성격의 영구 삭제만 제공한다.
        <ContextMenu>
          <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
          <ContextMenuContent>
            {contextActions.includes("open-directory-window") && (
              <ContextMenuItem onClick={() => void openPath(entry.path)}>
                {t("common.openInNewWindow")}
              </ContextMenuItem>
            )}
            {contextActions.includes("reveal-in-finder") && (
              <ContextMenuItem onClick={() => void revealItemInDir(entry.path)}>
                {t("sidebar.fileTree.revealInFinder")}
              </ContextMenuItem>
            )}
            {contextActions.includes("share") && (
              <>
                {contextActions.some((action) => action !== "share") && (
                  <ContextMenuSeparator />
                )}
                <ContextMenuItem onClick={() => void shareFileAtPointer(entry.path)}>
                  {t("common.share")}
                </ContextMenuItem>
              </>
            )}
            {contextActions.includes("delete-permanently") && (
              <>
                {contextActions.some((action) => action !== "delete-permanently") && (
                  <ContextMenuSeparator />
                )}
                <ContextMenuItem
                  variant="destructive"
                  disabled={deletingPath !== null}
                  onClick={() => onDeleteRemote(entry)}
                >
                  <Trash2 />
                  {t("sidebar.fileTree.deleteRemote.menuItem")}
                </ContextMenuItem>
              </>
            )}
          </ContextMenuContent>
        </ContextMenu>
      ) : (
        row
      )}
      {open && (
        <>
          {loading && (
            <div
              className="py-1.5 text-meta leading-none text-muted-foreground"
              style={{ paddingLeft: 8 + (depth + 1) * 18 + 18 }}
            >
              …
            </div>
          )}
          {children?.map((c) => (
            <TreeNode
              key={c.path}
              entry={c}
              depth={depth + 1}
              ctx={ctx}
              selected={selected}
              refreshRevision={refreshRevision}
              dropTarget={dropTarget}
              dropPending={dropPending}
              onOpenFile={onOpenFile}
              onExternalDragOver={onExternalDragOver}
              onExternalDrop={onExternalDrop}
              deletingPath={deletingPath}
              onDeleteRemote={onDeleteRemote}
              deleteConfirmPath={deleteConfirmPath}
              onDeleteConfirm={onDeleteConfirm}
              onDeleteCancel={onDeleteCancel}
            />
          ))}
          {loadError && !loading && (
            <button
              type="button"
              className="block w-full py-1.5 text-left text-meta leading-none text-destructive hover:underline"
              style={{ paddingLeft: 8 + (depth + 1) * 18 + 18 }}
              onClick={reload}
            >
              {t("sidebar.fileTree.loadFailedRetry")}
            </button>
          )}
          {children?.length === 0 && !loading && !loadError && (
            <div
              className="py-1.5 text-meta leading-none text-muted-foreground"
              style={{ paddingLeft: 8 + (depth + 1) * 18 + 18 }}
            >
              {t("sidebar.fileTree.emptyFolder")}
            </div>
          )}
        </>
      )}
    </>
  );
}

export function FileTree({
  cwd,
  source,
  hostId,
  onOpenFile,
  beforeTree,
}: {
  cwd: string;
  source: "local" | "ssh";
  hostId?: string;
  onOpenFile: (path: string) => void;
  /** 검색 입력과 트리 사이에 들어가는 슬롯 — 시안 2391:44516의 "최근 파일"
   *  섹션과 구분선이 여기 산다. 트리 스크롤 영역 밖이라 함께 스크롤되지 않고,
   *  검색은 시안대로 패널 맨 위에 남는다. */
  beforeTree?: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [dropPending, setDropPending] = useState<string | null>(null);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const [deletingPath, setDeletingPath] = useState<string | null>(null);
  /** Entry path awaiting in-place delete confirmation. */
  const [confirmingDeletePath, setConfirmingDeletePath] = useState<string | null>(null);
  // 펼침·선택·스크롤 모두 같은 트리 키를 쓴다.
  const expansionKey = fileTreeKey(source, hostId, cwd);
  const { selected, setFileTreeSelected, showGitIgnored } = useFileTreeState(expansionKey);
  const { entries, error } = useDirectoryListing({ path: cwd, source, hostId, showGitIgnored }, refreshRevision);
  const [query, setQuery] = useState("");
  const [searchState, setSearchState] = useState<FileTreeSearchState | null>(null);
  const [activeSearchIndex, setActiveSearchIndex] = useState(-1);
  const searchSequence = useRef(0);
  const searchListId = useId();
  const normalizedQuery = query.trim();
  const searchKey = normalizedQuery ? `${expansionKey}\0${normalizedQuery}` : null;
  const visibleSearchState = searchState?.key === searchKey ? searchState : null;
  const searchResults = visibleSearchState?.results ?? [];
  const searchLoading = searchKey !== null && (!visibleSearchState || visibleSearchState.loading);

  const ctx: Ctx = { source, hostId, expansionKey, showGitIgnored };

  const touchExpansion = useFileTreeExpansion((s) => s.touch);
  useEffect(() => {
    touchExpansion(expansionKey);
  }, [expansionKey, touchExpansion]);

  // Confirmation happens on the row itself (SOUL §6): the context-menu action
  // arms `confirmingDeletePath` and the armed row's own confirm lands here.
  const deleteRemoteEntry = useCallback(
    async (entry: DirEntry) => {
      if (source !== "ssh" || deletingPath) return;
      setDeletingPath(entry.path);
      try {
        const host = findFileHost(hostId);
        if (!host) throw new Error(t("common.hostNotFound"));
        await sshDeleteFile({
          connectOpts: hostToOpts(host),
          root: cwd,
          path: entry.path,
          isDirectory: entry.isDir,
        });
        publishFileDeletion({
          source: "ssh",
          hostId,
          path: entry.path,
          isDirectory: entry.isDir,
        });
        if (
          selected === entry.path ||
          (entry.isDir && selected?.startsWith(`${entry.path}/`))
        ) {
          setFileTreeSelected(expansionKey, "");
        }
        discardDeletedFileDrafts({ hostId: hostId ?? "", path: entry.path, isDirectory: entry.isDir });
        setRefreshRevision((revision) => revision + 1);
        showToast(t("sidebar.fileTree.deleteRemote.success", { name: entry.name }));
      } catch (deleteError) {
        showErrorToast(
          t("sidebar.fileTree.deleteRemote.failed", { error: String(deleteError) }),
        );
      } finally {
        setDeletingPath(null);
        setConfirmingDeletePath(null);
      }
    },
    [cwd, deletingPath, expansionKey, hostId, selected, setFileTreeSelected, source],
  );

  const addDroppedFiles = useCallback(
    async (destination: string, files: File[]) => {
      setDropPending(destination);
      setDropTarget(null);
      try {
        const payloads = await prepareDroppedFilePayloads(files);
        if (source === "local") {
          await saveFilesToDirectory(destination, payloads);
        } else {
          const host = findFileHost(hostId);
          if (!host) throw new Error(t("common.hostNotFound"));
          await uploadSshFilesToDirectory(hostToOpts(host), destination, payloads);
        }
        setRefreshRevision((revision) => revision + 1);
        showToast(t("sidebar.fileTree.addFiles.success", { n: payloads.length }));
      } catch (dropError) {
        showErrorToast(
          t("sidebar.fileTree.addFiles.failed", {
            error: describeFileTreeFileDropError(dropError, t),
          }),
        );
      } finally {
        setDropPending(null);
      }
    },
    [hostId, source],
  );

  const acceptExternalDrag = useCallback(
    (destination: string, event: ReactDragEvent<HTMLElement>) => {
      if (!isExternalFileDrag(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = dropPending ? "none" : "copy";
      if (!dropPending) setDropTarget(destination);
    },
    [dropPending],
  );

  const receiveExternalDrop = useCallback(
    (destination: string, event: ReactDragEvent<HTMLElement>) => {
      if (!isExternalFileDrag(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      const files = Array.from(event.dataTransfer.files);
      setDropTarget(null);
      if (!dropPending && files.length > 0) void addDroppedFiles(destination, files);
    },
    [addDroppedFiles, dropPending],
  );

  // 루트를 옮기면 이전 루트의 결과가 잠깐이라도 보이지 않게 검색을 초기화한다.
  useEffect(() => {
    setQuery("");
    setSearchState(null);
    setActiveSearchIndex(-1);
    searchSequence.current += 1;
  }, [expansionKey]);

  useEffect(() => {
    if (!searchKey) {
      searchSequence.current += 1;
      setSearchState(null);
      setActiveSearchIndex(-1);
      return;
    }

    const sequence = ++searchSequence.current;
    setSearchState({ key: searchKey, loading: true, results: [], error: null });
    setActiveSearchIndex(-1);
    const timer = window.setTimeout(() => {
      const command = buildFileTreeSearchCommand(cwd, normalizedQuery);
      void runWorkspaceCommand({ source, hostId }, command).then(
        (result) => {
          if (sequence !== searchSequence.current) return;
          if (result.code !== 0 && !result.stdout.trim()) {
            setSearchState({
              key: searchKey,
              loading: false,
              results: [],
              error: result.stderr.trim() || `exit ${result.code}`,
            });
            setActiveSearchIndex(-1);
            return;
          }
          const results = parseFileTreeSearchResults(cwd, normalizedQuery, result.stdout);
          setSearchState({ key: searchKey, loading: false, results, error: null });
          setActiveSearchIndex(results.length > 0 ? 0 : -1);
        },
        (searchError) => {
          if (sequence !== searchSequence.current) return;
          setSearchState({
            key: searchKey,
            loading: false,
            results: [],
            error: String(searchError),
          });
          setActiveSearchIndex(-1);
        },
      );
    }, 160);

    return () => window.clearTimeout(timer);
  }, [cwd, hostId, normalizedQuery, searchKey, source]);

  // 이 루트에서 보던 위치로 되돌린다 — 그 루트의 목록이 그려진 뒤에만. 검색
  // 중에는 기억하지 않는다(그 목록은 위치가 속한 목록이 아니다).
  useSidebarScrollMemory(rootRef, searchKey ? null : expansionKey, entries);

  const openFile = (path: string) => {
    setFileTreeSelected(expansionKey, path);
    onOpenFile(path);
  };

  const openSearchResult = (result: FileTreeSearchResult) => {
    openFile(result.path);
    setQuery("");
  };

  useEffect(() => {
    if (activeSearchIndex < 0) return;
    rootRef.current
      ?.querySelector<HTMLElement>(`[data-file-search-index="${activeSearchIndex}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [activeSearchIndex]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 2391:46258 — px-12 / pt-8 / pb-6. 입력은 32px에 12px 아이콘이 왼쪽
          12px에 서고 글자는 28px에서 시작한다(스페이스 탭 검색과 같은 기하). */}
      <div className="shrink-0 px-3 pt-3.5 pb-2">
        <SearchField
          className="h-8"
          inputClassName="h-8"
          type="search"
          role="combobox"
          aria-label={t("sidebar.fileTree.search")}
          aria-controls={searchListId}
          aria-expanded={searchKey !== null}
          aria-autocomplete="list"
          aria-activedescendant={
            activeSearchIndex >= 0 ? `${searchListId}-option-${activeSearchIndex}` : undefined
          }
          placeholder={t("sidebar.fileTree.search")}
          value={query}
          loading={searchLoading}
          onClear={() => setQuery("")}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActiveSearchIndex((current) =>
                searchResults.length === 0
                  ? -1
                  : Math.min(current + 1, searchResults.length - 1),
              );
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActiveSearchIndex((current) =>
                searchResults.length === 0
                  ? -1
                  : current <= 0
                    ? searchResults.length - 1
                    : current - 1,
              );
            } else if (event.key === "Enter" && activeSearchIndex >= 0) {
              event.preventDefault();
              const result = searchResults[activeSearchIndex];
              if (result) openSearchResult(result);
            } else if (event.key === "Escape" && query) {
              event.preventDefault();
              setQuery("");
            }
          }}
        />
      </div>
      <SidebarScrollArea
        edgeFade
        ref={rootRef}
        className={cn(
          "min-h-0 flex-1",
          dropTarget === cwd && "bg-primary/5 inset-ring-1 inset-ring-primary/30",
        )}
        // Figma 3404:86362 "SidebarGroup": 8px on the sides, and no gap between
        // the group label and the first row — both are 32px boxes that stack
        // flush, so the viewport takes no top padding. The old 6px (2391:44373)
        // pushed the tree down and read as a gap the comp does not draw.
        // The side 8px belongs here and not on each row: rows are w-full, so
        // without it a hover or selected fill runs the full width of the pane
        // instead of the comp's inset pill. Everything in this viewport — the
        // group labels, the recent entries, the tree rows, the search results —
        // takes its side inset from here.
        // Row-to-row spacing stays with the rows, not the viewport: Radix
        // ScrollArea wraps children in a display:table element, so a flex gap on
        // the viewport has one item to act on and does nothing.
        viewportClassName="px-2 pb-3"
        data-file-drop-target={cwd}
        aria-busy={dropPending !== null}
        onDragOver={(event) => acceptExternalDrag(cwd, event)}
        onDrop={(event) => receiveExternalDrop(cwd, event)}
        onDragLeave={(event) => {
          const next = event.relatedTarget;
          if (!(next instanceof Node) || !event.currentTarget.contains(next)) {
            setDropTarget(null);
          }
        }}
      >
        {/* Recent files, the group labels and the tree scroll as one column —
            the comp stacks both SidebarGroups in a single flow with no rule
            between them, so pinning the labels above a separate tree scroller
            made the boundary look like a division the design does not draw.
            Hidden while searching: results render in this same area, and
            leaving the block in place pushed the first result out of view under
            a folder line naming a tree that was no longer shown. */}
        {searchKey === null && beforeTree}
        {searchKey ? (
          <div id={searchListId} role="listbox" aria-label={t("sidebar.fileTree.searchResults")}>
            {searchLoading && (
              <div className="px-2 py-2 text-xs text-muted-foreground" aria-live="polite">
                {t("common.searching")}
              </div>
            )}
            {visibleSearchState?.error && (
              <ErrorText className="px-2 py-2 break-all">
                {visibleSearchState.error}
              </ErrorText>
            )}
            {!searchLoading && !visibleSearchState?.error && searchResults.length === 0 && (
              <div className="px-2 py-2 text-xs text-muted-foreground">
                {t("common.noMatches")}
              </div>
            )}
            {searchResults.map((result, index) => (
              <button
                key={result.path}
                id={`${searchListId}-option-${index}`}
                type="button"
                role="option"
                aria-selected={index === activeSearchIndex}
                data-file-search-index={index}
                className={cn(
                  "flex w-full items-start gap-1.5 rounded-[6px] px-2 py-1.5 text-left hover:bg-glass-tint-hover",
                  index === activeSearchIndex &&
                    "bg-glass-tint-selected",
                )}
                onMouseEnter={() => setActiveSearchIndex(index)}
                onClick={() => openSearchResult(result)}
              >
                <FileGlyph />
                <span className="min-w-0 flex-1">
                  <OverflowRevealText className="block text-xs leading-none" text={result.name} />
                  <OverflowRevealText text={result.relativePath}
                    className="mt-1 block text-meta leading-none text-muted-foreground" />
                </span>
              </button>
            ))}
            {searchResults.length === FILE_TREE_SEARCH_LIMIT && (
              <div className="px-2 py-2 text-meta text-muted-foreground">
                {t("common.topResultsOnly", {
                  n: FILE_TREE_SEARCH_LIMIT,
                })}
              </div>
            )}
          </div>
        ) : (
          <>
            {entries === null && (
              <div className="px-2 py-2 text-xs text-muted-foreground">
                {t("common.loading")}
              </div>
            )}
            {error && <ErrorText className="px-2 py-2 break-all">{error}</ErrorText>}
            {entries?.map((r) => (
              <TreeNode
                key={r.path}
                entry={r}
                depth={0}
                ctx={ctx}
                selected={selected}
                refreshRevision={refreshRevision}
                dropTarget={dropTarget}
                dropPending={dropPending}
                onOpenFile={openFile}
                onExternalDragOver={acceptExternalDrag}
                onExternalDrop={receiveExternalDrop}
                deletingPath={deletingPath}
                onDeleteRemote={(entry) => setConfirmingDeletePath(entry.path)}
                deleteConfirmPath={confirmingDeletePath}
                onDeleteConfirm={(entry) => void deleteRemoteEntry(entry)}
                onDeleteCancel={() => setConfirmingDeletePath(null)}
              />
            ))}
            {entries?.length === 0 && !error && (
              <div className="px-2 py-2 text-xs text-muted-foreground">{t("sidebar.fileTree.noFiles")}</div>
            )}
          </>
        )}
      </SidebarScrollArea>
    </div>
  );
}
