import {
  type WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Plus, TriangleAlert, X } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  readDesktopTabOrderState,
  readShortcutOverrides,
  useDesktopBarState,
  useFontSizeControlState,
} from "@/components/workspace/useDesktopBarState";
import { markDesktopStartsEmpty, movePanelToDesktop } from "@/lib/workspace/dock";
import { getDragState, setDragState } from "@/lib/workspace/pane/paneDragState";
import { requestDesktopPrewarm } from "@/lib/workspace/desktop/desktopPrewarm";
import { allowsManualReorder, orderDesktopTabs } from "@/lib/workspace/desktop/desktopTabOrder";
import { matchesChord, shortcutChord } from "@/lib/settings/shortcutBindings";
import { Titled, Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { armDesktopTearOut } from "@/lib/workspace/desktop/desktopTearOut";
import {
  desktopAddButtonClass,
  desktopBarClass,
  desktopTabClass,
  desktopTabNumberClass,
  desktopTabStripClass,
} from "@/lib/workspace/desktop/desktopTabStyle";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import {
  persistenceStatus,
  subscribePersistenceStatus,
} from "@/lib/persistence/persistenceStatus";
import { confirmAndCloseDesktop } from "@/lib/workspace/desktop/desktopClose";
import { balanceActiveSpacePanes } from "@/lib/workspace/pane/paneShortcuts";
import type { DesktopDropPosition } from "@/lib/workspace/desktop/desktopOrder";
import { ResourceMonitor } from "@/components/usage/ResourceMonitor";
import { UsageBadge } from "@/components/usage/UsageBadge";
import { DURE_DESKTOP_DRAG_TYPE } from "@/lib/platform/productDragPayload";
import {
  DEFAULT_TERMINAL_FONT_SIZE,
} from "@/lib/terminal/renderer/terminalFont";

/** 터미널 폰트 크기 컨트롤 (⌘+/⌘- 와 동일 값) */
function FontSizeControl() {
  const { size, setSize } = useFontSizeControlState();
  const label = t("workspace.desktopBar.terminalFontSize");
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex items-center gap-1 font-mono text-[11.5px] text-muted-foreground">
          <button type="button"
            className="rounded px-0.5 hover:bg-glass-tint-hover hover:text-foreground"
            onClick={() => setSize((n) => n - 1)}
          >
            A-
          </button>
          <button
            type="button"
            // A fixed 4ch slot: "9" and "13.5" measure the same, so A+ never slides
            // as the value changes (owner report 2026-09-10).
            className="min-w-[4ch] text-center tabular-nums hover:text-foreground"
            onClick={() => setSize(DEFAULT_TERMINAL_FONT_SIZE)}
          >
            {size}
          </button>
          <button type="button"
            className="rounded px-0.5 hover:bg-glass-tint-hover hover:text-foreground"
            onClick={() => setSize((n) => n + 1)}
          >
            A+
          </button>
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

function PersistenceIndicator() {
  const [status, setStatus] = useState(persistenceStatus);
  // Only a failed save shows, in every mode: it is a data-loss signal. The
  // quiet confirmations (saving, saved) that pro mode used to keep came off
  // 2026-09-10 (owner call) — normal execution stays quiet.
  useEffect(() => subscribePersistenceStatus(setStatus), []);
  if (status.phase !== "error") return null;
  const title = t("common.saveFailed", {
    error: status.message ?? t("workspace.error.unknown"),
  });
  return (
    <Titled title={title}>
      <span
        className="flex size-5 items-center justify-center text-destructive"
        role="status"
        aria-label={title}
      >
        <TriangleAlert className="size-3.5" />
      </span>
    </Titled>
  );
}

export function DesktopBar() {
  const {
    spaces,
    activeSpaceId,
    setActiveSpace,
    addSpace,
    renameSpace,
    reorderSpace,
    tabOrder,
    spaceVisits,
  } = useDesktopBarState();
  const manualReorder = allowsManualReorder(tabOrder);
  const visibleDesktops = useMemo(
    () => orderDesktopTabs(spaces.filter((d) => d.kind !== "popout"), tabOrder, spaceVisits),
    [spaces, tabOrder, spaceVisits],
  );

  // A new desktop is named first and starts empty. Creating it *with* a shell
  // decided the work before the user did — the sidebar's per-repository
  // actions and the pane surfaces already start terminals and agents, and they
  // know which repository the user meant. This bar only makes the space.
  //
  // markDesktopStartsEmpty must be set in the same tick as addSpace: activating
  // the new desktop mounts its Workspace, whose onReady would otherwise inherit
  // focusCtx and open a terminal.
  const [namingNewDesktop, setNamingNewDesktop] = useState(false);
  const [newDesktopName, setNewDesktopName] = useState("");
  const beginNewDesktop = () => {
    setNewDesktopName("");
    setNamingNewDesktop(true);
  };
  const commitNewDesktop = () => {
    setNamingNewDesktop(false);
    const name = newDesktopName.trim();
    // An empty name is not a cancel — the store's own numbering names it.
    markDesktopStartsEmpty(addSpace(name ? { name } : undefined));
  };
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  // hover-intent prewarm dwell 타이머 — 탭 하나만 유효(스트립 통과 시 갱신).
  const prewarmTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [desktopDropTarget, setDesktopDropTarget] = useState<{
    id: string;
    position: DesktopDropPosition;
  } | null>(null);
  const [closingDesktopId, setClosingDesktopId] = useState<string | null>(null);
  const draggingDesktop = useRef<string | null>(null);
  // Rename chosen from a tab's menu mounts the name input inside that tab —
  // the menu's trigger. The input opens only once the menu has closed and
  // given up its focus return: mounted any earlier, the closing menu handed
  // focus back to the tab, blurred the input and committed the untouched name.
  const renamingFromMenu = useRef<string | null>(null);

  // The strip scrolls sideways when the desktops outgrow it, and nothing said
  // so: the last visible tab ended clean at the edge as if it were the last
  // one (owner report 2026-09-14). The edges fade the way a sidebar list's
  // do (ScrollArea edgeFade) — from scroll position, never a static mask, so
  // a strip that fits fades nothing. 40px, not the list's 8: a row's fade
  // lands on its card's empty padding, but a tab is 8px of padding and then
  // its name, and a 16px fade cut a digit in half — "10" read as a broken
  // glyph, not a tab receding past the edge (owner report, same day). Sixty-
  // four — most of a tab — so what fades is a tab, and it is seen to be one
  // (forty still read narrow, owner call after seeing it).
  const stripRef = useRef<HTMLDivElement>(null);
  const [stripEdges, setStripEdges] = useState({ left: false, right: false });
  const syncStripEdges = useCallback(() => {
    const el = stripRef.current;
    if (!el) return;
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setStripEdges((prev) =>
      prev.left === left && prev.right === right ? prev : { left, right },
    );
  }, []);
  const tabCount = visibleDesktops.length;
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    syncStripEdges();
    const observer = new ResizeObserver(syncStripEdges);
    observer.observe(el);
    return () => observer.disconnect();
    // tabCount: a tab added or closed changes what overflows without a
    // resize or a scroll.
  }, [syncStripEdges, tabCount]);
  const stripFade = "64px";
  const stripMask =
    stripEdges.left || stripEdges.right
      ? `linear-gradient(to right, ${
          stripEdges.left
            ? `transparent 0, var(--mask-opaque) ${stripFade}`
            : "var(--mask-opaque) 0"
        }, ${
          stripEdges.right
            ? `var(--mask-opaque) calc(100% - ${stripFade}), transparent 100%`
            : "var(--mask-opaque) 100%"
        })`
      : undefined;
  // A mouse wheel moves the strip sideways. The strip scrolls on its x axis
  // only and hides its scrollbar, so a wheel's vertical delta — the only one
  // a mouse has — went nowhere and the strip read as stuck; only a trackpad's
  // sideways swipe or ⇧-wheel moved it (reported 2026-09-14). A swipe that
  // already carries a horizontal delta is left to the native scroll.
  const onStripWheel = useCallback(
    (event: ReactWheelEvent<HTMLDivElement>) => {
      const el = event.currentTarget;
      if (event.deltaX !== 0 || event.deltaY === 0) return;
      if (el.scrollWidth <= el.clientWidth) return;
      el.scrollLeft += event.deltaY;
    },
    [],
  );
  // The strip follows the active tab. ⌘-number, the sidebar and a new Space
  // all change the active desktop without touching the strip, which stayed
  // where it was with the active tab out of sight — a new Space appended past
  // the right edge, unseen (reported 2026-09-14). Nearest, so a tab already
  // on screen stays put; the tabs' scroll margin (desktopTabStyle) keeps a
  // revealed one clear of the edge fade.
  useEffect(() => {
    if (!activeSpaceId) return;
    document
      .getElementById(`desktop-tab-${activeSpaceId}`)
      ?.scrollIntoView?.({ inline: "nearest", block: "nearest" });
  }, [activeSpaceId]);

  // 창 드래그·더블클릭 최대화는 여기서 다루지 않는다. 이 스트립은 이제
  // WindowTitleBar 안에 살고(2070:32171), 그 바가 같은 핸들러를 이미 갖고
  // 있다. 여기에 또 달면 이벤트가 버블링되며 startDragging이 두 번 걸린다.

  // tmux-style Cmd+1..9 switching
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 새 데스크탑은 재지정 가능하므로 수정 키 사전 필터보다 먼저 본다 —
      // ⌘를 안 쓰는 조합으로 바꿔도 여기서 걸러지지 않게.
      if (matchesChord(shortcutChord("new-desktop", readShortcutOverrides()), e)) {
        e.preventDefault();
        // The shortcut the '+' advertises in its own label must do what the
        // '+' does — name first, then an empty desktop.
        beginNewDesktop();
        return;
      }
      // Balancing is a Space-wide verb with one visible home, the Space
      // tab's menu; the chord and the ⌘P command are its two other doors
      // (owner request 2026-09-14).
      if (matchesChord(shortcutChord("balance-panes", readShortcutOverrides()), e)) {
        e.preventDefault();
        balanceActiveSpacePanes();
        return;
      }
      // ⌘1..9는 범위 표기라 재지정 대상이 아니다 — 기존 판정을 그대로 쓴다.
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.altKey) return;
      const n = parseInt(e.key, 10);
      if (!e.shiftKey && n >= 1 && n <= 9) {
        // 표시 순서와 같은 규칙으로 센다 — 탭 위 "⌘{n}" 안내가 거짓이 되지 않게.
        const state = readDesktopTabOrderState();
        const d = orderDesktopTabs(
          state.spaces.filter((x) => x.kind !== "popout"),
          state.tabOrder,
          state.spaceVisits,
        )[n - 1];
        if (d) {
          e.preventDefault();
          setActiveSpace(d.id);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setActiveSpace, addSpace]);

  // 드래그가 데스크탑 탭 밖에서 끝나면(원래 자리/다른 dockview) 상태 정리
  useEffect(() => {
    const onEnd = () => {
      setDragState(null);
      setDropTarget(null);
      setDesktopDropTarget(null);
      draggingDesktop.current = null;
    };
    window.addEventListener("dragend", onEnd, true);
    return () => window.removeEventListener("dragend", onEnd, true);
  }, []);

  return (
    <div className={desktopBarClass}>
      {/* 데스크탑이 많으면 이 영역만 가로 스크롤 — 탭이 찌그러지거나 이름이 줄바꿈되지 않게 */}
      <div
        ref={stripRef}
        className={desktopTabStripClass}
        // Both spellings, as ScrollArea's edge fade sets them.
        style={{ maskImage: stripMask, WebkitMaskImage: stripMask }}
        onScroll={syncStripEdges}
        onWheel={onStripWheel}
        role="tablist"
        aria-label={t("workspace.desktopBar.desktops")}
      >
        {visibleDesktops.map((d, i) => (
          <ContextMenu key={d.id}>
          <Titled title={`${
              manualReorder
                ? t("workspace.desktopBar.manualOrderHint")
                : t("workspace.desktopBar.recentOrderHint")
            }${i < 9 ? ` · ⌘${i + 1}` : ""}`}>
            <ContextMenuTrigger asChild>
            <div
              id={`desktop-tab-${d.id}`}
              className={cn(
                desktopTabClass(d.id === activeSpaceId),
                // The sidebar's drop-target vocabulary (SpacesDesktopSection): a
                // tint plus a thin ring. The 2px full-strength ring read as a
                // solid box behind the tab on the glass (owner report 2026-09-10).
                dropTarget === d.id && "bg-glass-tint-hover ring-1 ring-ring/30",
                desktopDropTarget?.id === d.id &&
                  desktopDropTarget.position === "before" &&
                  "shadow-[-2px_0_0_0_var(--link)]",
                desktopDropTarget?.id === d.id &&
                  desktopDropTarget.position === "after" &&
                  "shadow-[2px_0_0_0_var(--link)]",
              )}
              role="tab"
              aria-selected={d.id === activeSpaceId}
              aria-controls={`desktop-panel-${d.id}`}
              tabIndex={d.id === activeSpaceId ? 0 : -1}
              data-nodrag
              draggable={manualReorder}
              onClick={() => setActiveSpace(d.id)}
              // hover-intent preload — 클릭 전에 워크스페이스 마운트를 앞당긴다.
              // 스트립을 스쳐 지나가는 포인터가 경유 탭을 전부 premount해 진짜
              // warm을 밀어내지 않도록, 잠깐 머문(dwell) 탭만 요청한다.
              onMouseEnter={() => {
                if (d.id === activeSpaceId) return;
                if (prewarmTimer.current !== undefined) {
                  clearTimeout(prewarmTimer.current);
                }
                prewarmTimer.current = setTimeout(() => {
                  prewarmTimer.current = undefined;
                  requestDesktopPrewarm(d.id);
                }, 120);
              }}
              onMouseLeave={() => {
                if (prewarmTimer.current !== undefined) {
                  clearTimeout(prewarmTimer.current);
                  prewarmTimer.current = undefined;
                }
              }}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget) return;
                if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
                let nextIndex = i;
                const count = visibleDesktops.length;
                if (event.key === "ArrowLeft") nextIndex = (i - 1 + count) % count;
                else if (event.key === "ArrowRight") nextIndex = (i + 1) % count;
                else if (event.key === "Home") nextIndex = 0;
                else if (event.key === "End") nextIndex = count - 1;
                else if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                const next = visibleDesktops[nextIndex];
                if (!next) return;
                setActiveSpace(next.id);
                requestAnimationFrame(() => document.getElementById(`desktop-tab-${next.id}`)?.focus());
              }}
              onDragStart={(e) => {
                setDragState(null);
                draggingDesktop.current = d.id;
                // 이 드래그가 앱 창 밖에서 끝나면 새 창으로 연다 (lib/desktopTearOut).
                armDesktopTearOut(d.id);
                e.dataTransfer.setData(DURE_DESKTOP_DRAG_TYPE, d.id);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragEnd={() => {
                draggingDesktop.current = null;
                setDesktopDropTarget(null);
              }}
              onDragOver={(e) => {
                if (draggingDesktop.current) {
                  e.preventDefault();
                  e.stopPropagation();
                  const rect = e.currentTarget.getBoundingClientRect();
                  const position =
                    e.clientX < rect.left + rect.width / 2 ? "before" : "after";
                  if (
                    desktopDropTarget?.id !== d.id ||
                    desktopDropTarget.position !== position
                  ) {
                    setDesktopDropTarget({ id: d.id, position });
                  }
                  return;
                }
                if (getDragState()) {
                  e.preventDefault(); // 드롭 허용
                  if (dropTarget !== d.id) setDropTarget(d.id);
                }
              }}
              onDragLeave={() => {
                setDropTarget((target) => (target === d.id ? null : target));
                setDesktopDropTarget((target) =>
                  target?.id === d.id ? null : target,
                );
              }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                const sourceId = draggingDesktop.current;
                if (sourceId) {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const position =
                    desktopDropTarget?.id === d.id
                      ? desktopDropTarget.position
                      : e.clientX < rect.left + rect.width / 2
                        ? "before"
                        : "after";
                  draggingDesktop.current = null;
                  setDesktopDropTarget(null);
                  reorderSpace(sourceId, d.id, position);
                  return;
                }
                setDropTarget(null);
                movePanelToDesktop(d.id);
                setActiveSpace(d.id);
              }}
              onDoubleClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setEditing(d.id);
                setDraft(d.name);
              }}
            >
              {editing === d.id ? (
                <input
                  autoFocus
                  aria-label={t("common.name")}
                  className="w-20 bg-transparent outline-none"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => {
                    if (draft.trim()) renameSpace(d.id, draft.trim());
                    setEditing(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    if (e.key === "Escape") setEditing(null);
                  }}
                />
              ) : (
                <>
                  {/* ⌘1..9와 같은 번호 — 시안에서는 이름과 한 덩어리(같은 색) */}
                  {/* The label is laid out twice in one grid cell: the visible
                      copy at the tab's current weight and an invisible copy at
                      the active tab's medium weight. The cell takes the wider of
                      the two, so a tab keeps one width whether or not it is
                      active — the strip used to ripple as the newly active tab
                      grew and its neighbours slid (owner report 2026-09-10). */}
                  <span className="grid min-w-0">
                    <span className="col-start-1 row-start-1 flex min-w-0 items-center gap-1">
                      <span className={desktopTabNumberClass}>{i + 1}</span>
                      <span className="max-w-[120px] truncate">{d.name}</span>
                    </span>
                    <span
                      aria-hidden="true"
                      className="invisible col-start-1 row-start-1 flex min-w-0 items-center gap-1 font-medium"
                    >
                      <span className={desktopTabNumberClass}>{i + 1}</span>
                      <span className="max-w-[120px] truncate">{d.name}</span>
                    </span>
                  </span>
                </>
              )}
              {/* The hover actions live in a slot the tab always lays out (comp
                  2613:97015: a 14px icon box after the label, 6px off it), so
                  revealing them on hover never widens the tab or shoves the tabs
                  to its right (owner report 2026-09-10). Hidden by visibility, not
                  display — the box keeps its width at rest. */}
              <span className="ml-0.5 flex min-w-3.5 shrink-0 items-center gap-1">
                {spaces.length > 1 && (
                  <Titled title={t("common.closeDesktop")}>
                    <button
                      type="button"
                      className="invisible grid size-3.5 place-items-center text-muted-foreground group-hover:visible hover:text-foreground"
                      aria-label={t("common.closeDesktop")}
                      disabled={closingDesktopId === d.id}
                      onClick={async (e) => {
                        e.stopPropagation();
                        setClosingDesktopId(d.id);
                        try {
                          await confirmAndCloseDesktop(d.id, d.name);
                        } finally {
                          setClosingDesktopId(null);
                        }
                      }}
                    >
                      <X className="size-3" />
                    </button>
                  </Titled>
                )}
              </span>
            </div>
            </ContextMenuTrigger>
          </Titled>
          {/* The Space's own verbs. Balancing acts on the panes of the Space
              this tab names, so it lives here rather than in the window's
              right-hand cluster among app-wide meters, where it read as an
              unexplained global toggle (owner call 2026-09-14, over #773's
              placement). Only the active Space is mounted to balance; the
              item says so and stays disabled on the others. */}
          <ContextMenuContent
            onCloseAutoFocus={(event) => {
              if (renamingFromMenu.current !== d.id) return;
              renamingFromMenu.current = null;
              event.preventDefault();
              setEditing(d.id);
              setDraft(d.name);
            }}
          >
            <ContextMenuItem
              onSelect={() => {
                renamingFromMenu.current = d.id;
              }}
            >
              {t("workspace.desktopBar.rename")}
            </ContextMenuItem>
            <ContextMenuItem
              disabled={d.id !== activeSpaceId}
              onSelect={balanceActiveSpacePanes}
            >
              {t("workspace.desktopBar.balancePanes")}
            </ContextMenuItem>
            {spaces.length > 1 && (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem
                  disabled={closingDesktopId === d.id}
                  onSelect={() => {
                    setClosingDesktopId(d.id);
                    void confirmAndCloseDesktop(d.id, d.name).finally(() =>
                      setClosingDesktopId(null),
                    );
                  }}
                >
                  {t("common.closeDesktop")}
                </ContextMenuItem>
              </>
            )}
          </ContextMenuContent>
          </ContextMenu>
        ))}
        {/* '+'는 이름 입력으로 열린다 — 무엇을 띄울지 고르는 메뉴가 아니라
            (사용자 요청 2026-08-31). 커밋하면 빈 데스크탑이 생기고, 그 안에서
            무엇을 시작할지는 사이드바·pane이 각자의 맥락으로 묻는다. */}
        {namingNewDesktop ? (
          <div className={desktopTabClass(false)}>
            <input
              autoFocus
              aria-label={t("workspace.desktopBar.newDesktopName")}
              placeholder={t("workspace.desktopBar.newDesktopName")}
              className="w-24 bg-transparent outline-none placeholder:text-muted-foreground/60"
              value={newDesktopName}
              onChange={(e) => setNewDesktopName(e.target.value)}
              // 이름을 비운 채 초점을 잃으면 만들지 않는다 — 스트립을 지나가다
              // 눌린 '+'가 데스크탑을 남기지 않게. Enter는 비어도 만든다.
              onBlur={() => {
                if (newDesktopName.trim()) commitNewDesktop();
                else setNamingNewDesktop(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitNewDesktop();
                }
                if (e.key === "Escape") setNamingNewDesktop(false);
              }}
            />
          </div>
        ) : (
          <Titled title={t("workspace.desktopBar.newDesktop")}>
            <button
              type="button"
              className={desktopAddButtonClass}
              aria-label={t("workspace.desktopBar.newDesktop")}
              onClick={beginNewDesktop}
            >
              <Plus className="size-3.5" />
            </button>
          </Titled>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-[18px] pl-3" data-nodrag>
        <PersistenceIndicator />
        <ResourceMonitor />
        <FontSizeControl />
        <UsageBadge />
      </div>
    </div>
  );
}
