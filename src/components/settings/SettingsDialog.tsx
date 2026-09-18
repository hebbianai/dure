import { useEffect, useMemo, useState } from "react";
import { EnvironmentsPage } from "./EnvironmentsPage";
import { AccountsPage } from "@/components/settings/AccountsPage";
import { AgentToolingPage } from "@/components/settings/AgentToolingPage";
import { PrivacyPage } from "@/components/settings/PrivacyPage";
import { MacosPermsPage } from "@/components/settings/MacosPermsPage";
import { MobileConnectivityPage } from "@/components/settings/MobileConnectivityPage";
import { NotificationsPage } from "@/components/settings/NotificationsPage";
import { StatsPage } from "@/components/settings/StatsPage";
import { X } from "lucide-react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { IconButton } from "@/components/ui/icon-button";
import { GeneralPage } from "@/components/settings/GeneralPage";
import { TerminalPage } from "@/components/settings/TerminalPage";
import { AppearancePage } from "@/components/settings/AppearancePage";
import { ShortcutsPage } from "@/components/settings/ShortcutsPage";
import { SearchField } from "@/components/ui/search-field";
import { StoragePage } from "@/components/settings/StoragePage";
import { SidebarGroupLabel, sidebarLabelTone } from "@/components/sidebar/SidebarItems";
import { cn } from "@/lib/utils";
import { isMacPlatform } from "@/lib/workspace/desktop/desktopPlatform";
import { t } from "@/lib/i18n";
import { filterSettingsNavigation } from "@/lib/settings/settingsNavigation";
import { settingsNavigationGroups } from "@/components/settings/settingsNav";
import { useBasicFoldedSettingsPages } from "@/components/workspace/useInterfaceMode";
import { ProvidersPage } from "@/components/settings/ProvidersPage";
// ================= 새 설정 창 (Figma 420-18557) =================
// 좌측 카테고리 사이드바 + 우측 페이지. 기존 기능(계정·MCP·플러그인·언어 등)을
// 페이지로 재배치한다. 디자인 색은 다크 테마 시맨틱 토큰과 맞춘다.

// PageId는 settingsNav 소유(순환 절단) — 기존 임포터를 위해 재-export.
import type { PageId } from "@/components/settings/settingsNav";
export type { PageId };

/** macOS 권한 (Figma 439-26582): 실측 가능한 상태(접근성·화면 녹화·전체 디스크)는
 *  Rust로 조회하고, 나머지는 '수동 확인' — 모든 행에 시스템 설정 딥링크. */
export function SettingsDialog({
  onClose,
  initialPage,
}: {
  onClose: () => void;
  /** 열 때 바로 보여줄 페이지 (예: 사용량 배지에서 'usage'로 진입) */
  initialPage?: PageId;
}) {
  const macPlatform = isMacPlatform();
  const firstPage = initialPage === "macos" && !macPlatform ? "privacy" : initialPage;
  // Default landing is the simplest page (philosophy invariant 11: concise
  // defaults). Accounts is the most complex settings surface — deep links
  // still reach it via initialPage.
  const [page, setPage] = useState<PageId>(firstPage ?? "general");
  const [query, setQuery] = useState("");

  const foldedPages = useBasicFoldedSettingsPages();
  const nav = useMemo(
    () => settingsNavigationGroups(macPlatform, foldedPages),
    [macPlatform, foldedPages],
  );
  const filteredNav = useMemo(
    () => filterSettingsNavigation(nav, query),
    [nav, query],
  );
  /** 걸러진 순서대로 편 목록 — ↑/↓ 이동과 Enter 점프가 같은 순서를 쓴다. */
  const navItems = useMemo(() => filteredNav.flatMap((g) => g.items), [filteredNav]);

  // 검색으로 현재 페이지가 목록에서 사라지면 첫 결과로 옮긴다 — 그러지 않으면
  // 왼쪽에 없는 페이지가 오른쪽에 계속 떠 있어 무엇을 보고 있는지 어긋난다.
  useEffect(() => {
    if (!query.trim() || navItems.length === 0) return;
    if (navItems.some((item) => item.id === page)) return;
    setPage(navItems[0].id);
  }, [query, navItems, page]);

  /** 목록 안에서 위/아래로 옮긴다. 끝에서 반대편으로 감싼다. */
  const moveNav = (delta: number) => {
    if (navItems.length === 0) return;
    const index = navItems.findIndex((item) => item.id === page);
    const next = navItems[(index + delta + navItems.length) % navItems.length];
    setPage(next.id);
    requestAnimationFrame(() => document.getElementById(`settings-nav-${next.id}`)?.focus());
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        showCloseButton={false}
        onInteractOutside={(e) => e.preventDefault()}
        // 1080×720 is the comp's frame (2496:59514). Height used to be 86vh
        // alone, which outgrew the comp on any window taller than ~840px
        // (owner report 2026-09-09); the comp now caps it and 86vh only
        // shrinks it on short windows.
        style={{
          width: "min(94vw, 1080px)",
          maxWidth: "1080px",
          height: "min(86vh, 720px)",
        }}
        // The dialog is built from the window's own two surfaces (owner call
        // 2026-09-09): its nav is the sidebar — DialogContent's own material
        // since every dialog moved to it the same day — and its page is the
        // terminal surface (below). Depth stays the shadow's job.
        className="block gap-0 overflow-hidden p-px"
      >
        <DialogTitle className="sr-only">{t("settings.dialog.title")}</DialogTitle>
        <div className="flex h-full min-h-0 w-full">

        {/* 사이드바 — 셸 유리가 그대로 비치고, 구분선은 오른쪽 면의 hairline이 맡는다 */}
        <div className="flex w-[270px] shrink-0 flex-col pt-3">
          <div className="flex h-6 items-center px-4">
            <span className="truncate text-xs font-semibold text-muted-foreground">
              {t("settings.dialog.title")}
            </span>
          </div>
          <div className="px-3 pt-2">
            <SearchField
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  moveNav(1);
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  moveNav(-1);
                } else if (e.key === "Enter" && navItems.length > 0) {
                  e.preventDefault();
                  setPage(navItems[0].id);
                  document.getElementById(`settings-nav-${navItems[0].id}`)?.focus();
                }
              }}
              placeholder={t("settings.dialog.search.placeholder")}
              inputClassName="h-8"
            />
          </div>
          <div className="mt-1 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 pt-2 pb-3">
            {filteredNav.map((g) => (
              <div key={g.group} className="flex flex-col">
                <SidebarGroupLabel>{g.group}</SidebarGroupLabel>
                <div className="flex flex-col gap-0.5">
                {g.items.map((it) => (
                  <button type="button"
                    key={it.id}
                    id={`settings-nav-${it.id}`}
                    role="tab"
                    aria-selected={page === it.id}
                    tabIndex={page === it.id ? 0 : -1}
                    onKeyDown={(e) => {
                      if (e.key === "ArrowDown") {
                        e.preventDefault();
                        moveNav(1);
                      } else if (e.key === "ArrowUp") {
                        e.preventDefault();
                        moveNav(-1);
                      }
                    }}
                    onClick={() => setPage(it.id)}
                    className={cn(
                      "group/label flex h-8 items-center gap-2 rounded-md px-2 text-left",
                      // The sidebar's own row rules (SidebarItems): muted at rest,
                      // sidebar-foreground when selected or hovered, selected tint,
                      // hover tint. The nav used to hold every row at full
                      // foreground (owner request 2026-09-10: follow the main
                      // sidebar's colour rules).
                      sidebarLabelTone(page === it.id),
                      page === it.id ? "bg-glass-tint-selected" : "hover:bg-glass-tint-hover",
                    )}
                  >
                    <it.icon className="size-3.5 shrink-0" />
                    <span className="truncate text-xs">{it.label}</span>
                  </button>
                ))}
                </div>
              </div>
            ))}
            {filteredNav.length === 0 && (
              <p className="px-2 pt-1 text-xs text-muted-foreground">
                {t("settings.dialog.search.noMatch", { query: query.trim() })}
              </p>
            )}
          </div>
        </div>
        {/* 콘텐츠 — 셸 유리 위에 얹히는 오버레이 면 (Figma 2496:59537).
            시안의 Main Area는 hairline만이 아니라 Glass/sheet 그림자를 왼쪽으로
            드리운다: 사이드바가 유리라 hairline 한 줄만으로는 두 면이 같은
            평면에 붙어 보인다. DOM에서 사이드바 뒤에 오므로 그림자가 그 위에
            얹힌다 — 시안에서 사이드바 오른쪽 끝이 어두워지는 그 그라데이션이다. */}
        {/* 9px, not 18: the sheet nests one 1px frame (`p-px` on DialogContent)
            inside a 10px panel, so its corner is the panel's minus that frame.
            At 18 it curved harder than the frame around it and the two arcs
            disagreed where the sheet meets the sidebar (사용자 지적
            2026-09-08). */}
        <div className="flex min-w-0 flex-1 flex-col rounded-l-[9px] bg-glass-hairline pl-px shadow-[var(--glass-shadow-sheet-edge)]">
          {/* The page is the terminal's surface: the palette background at the
              user's surface alpha, exactly what a terminal pane paints. */}
          <div className="flex min-h-0 flex-1 flex-col rounded-[9px] bg-surface-terminal text-foreground">
            {/* Dialog chrome stays outside the page scroller, so its controls
                never compete with the page scrollbar for the right edge. */}
            <div
              data-slot="settings-dialog-header"
              className="flex h-12 shrink-0 items-center justify-end px-3.5"
            >
              <DialogClose asChild>
                <IconButton title={t("common.close")} showTooltip={false}>
                  <X />
                </IconButton>
              </DialogClose>
            </div>
            {/* The page dissolves into the chrome row above it instead of
                being sliced by it. Nothing up there explains a cut — the close
                button sits on the same surface — so a heading scrolling past
                the edge just lost its top half (owner report 2026-09-14). The
                16px of top padding is what the mask eats at rest, so the first
                section is drawn whole until something actually scrolls under
                it. Same idiom as the sidebar's one-line viewports. */}
            {/* The scroller stops 12px short of the page's right edge so its
                bar rides inside the rounded page instead of against its border
                (owner report 2026-09-14); the content keeps its 36px from the
                edge (24 inside + the 12 outside). */}
            <div
              data-slot="settings-dialog-scroll-page"
              className="mr-3 flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto pt-4 pr-6 pb-11 pl-9 [mask-image:linear-gradient(to_bottom,transparent_0,black_16px)]"
            >
            {page === "accounts" && <AccountsPage onClose={onClose} />}
            {page === "general" && <GeneralPage />}
            {page === "terminal" && <TerminalPage />}
            {page === "appearance" && <AppearancePage />}
            {page === "shortcuts" && <ShortcutsPage />}
            {page === "storage" && <StoragePage />}
            {page === "environments" && <EnvironmentsPage />}
            {page === "usage" && <StatsPage />}
            {page === "agentTooling" && <AgentToolingPage />}
            {page === "providers" && <ProvidersPage />}
            {page === "notifications" && <NotificationsPage />}
            {macPlatform && page === "macos" && <MacosPermsPage />}
            {page === "mobile" && <MobileConnectivityPage />}
            {page === "privacy" && <PrivacyPage />}
            </div>
          </div>
        </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
