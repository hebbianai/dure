// 설정 › 단축키 페이지 — SettingsDialog에서 추출(god-file 다이어트).
// 상태 필터·충돌 판정·재지정 해석은 전부 lib/shortcutBindings.ts의 순수
// 로직이 하고, 여기는 렌더와 키 캡처 배선만 담당한다.

import { useEffect, useMemo, useState } from "react";
import { RotateCw, TerminalSquare, X } from "lucide-react";
import { useShortcutsPageState } from "@/components/settings/useShortcutsPageState";
import { Titled } from "@/components/ui/tooltip";
import { shortcutGroups } from "@/lib/settings/settingsShortcuts";
import {
  chordFromEvent,
  conflictingShortcutIds,
  filterShortcuts,
  isBindableChord,
  resolveShortcuts,
  setShortcutCaptureActive,
  shortcutStatusCounts,
  type ResolvedShortcut,
  type ShortcutStatusFilter,
} from "@/lib/settings/shortcutBindings";
import { FlatRow } from "@/components/settings/FlatRow";
import { PageTitle } from "@/components/settings/PageTitle";
import { IconButton } from "@/components/ui/icon-button";
import { SelectField, SelectOption } from "@/components/ui/select-field";
import { Kbd } from "@/components/ui/kbd";
import { SearchField } from "@/components/ui/search-field";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** 단일 키캡 — 시퀀스 구분자 "…"만 여기서 걸러 평문으로 그린다. */
function KeyCap({ label }: { label: string }) {
  if (label === "…") return <span className="px-0.5 text-xs text-muted-foreground">…</span>;
  return <Kbd>{label}</Kbd>;
}

/** 단축키 (Figma 448-34433): 터미널 우선순위 + 검색·상태 필터 + 그룹 목록. 실 데이터. */
export function ShortcutsPage() {
  const { termFirst, setUi, overrides, setShortcutOverride, resetShortcutOverride } =
    useShortcutsPageState();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<ShortcutStatusFilter>("all");
  /** 지금 키 입력을 기다리는 명령 id. 눌린 조합이 그대로 바인딩된다. */
  const [capturing, setCapturing] = useState<string | null>(null);
  /** 수정 키 없는 조합을 눌렀을 때의 안내 — 조용히 무시하면 왜 안 먹는지 모른다. */
  const [captureHint, setCaptureHint] = useState(false);

  const resolved = useMemo(() => resolveShortcuts(overrides), [overrides]);
  const counts = useMemo(() => shortcutStatusCounts(resolved), [resolved]);
  const conflicts = useMemo(() => conflictingShortcutIds(resolved), [resolved]);
  const shown = useMemo(
    () => filterShortcuts(resolved, status, query, (command) => t(command)),
    [resolved, status, query],
  );
  // 카탈로그의 그룹 순서를 유지한 채 걸러진 항목만 남긴다.
  const groups = useMemo(() => {
    const allowed = new Set(shown.map((item) => item.id));
    const byId = new Map(shown.map((item) => [item.id, item]));
    return shortcutGroups().map((group) => ({
      group: group.group,
      items: group.items
        .filter((item) => allowed.has(item.id))
        .map((item) => byId.get(item.id) as ResolvedShortcut),
    })).filter((group) => group.items.length > 0);
  }, [shown]);

  // 캡처 중에는 전역 단축키보다 먼저 키를 가로챈다 — 그러지 않으면 ⌘W를
  // 지정하려다 pane이 닫힌다.
  useEffect(() => {
    if (!capturing) {
      setShortcutCaptureActive(false);
      return;
    }
    // 전역 단축키를 잠근다. stopPropagation으로는 부족하다 — 앱 전역 핸들러는
    // 같은 window 노드에 더 먼저 등록돼 있어서 그대로 실행된다.
    setShortcutCaptureActive(true);
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setCapturing(null);
        return;
      }
      const chord = chordFromEvent(event);
      if (!chord) return; // 수정 키만 누른 상태 — 계속 기다린다
      if (!isBindableChord(chord)) {
        // Space·Enter 같은 맨 키를 받으면 앱 전체 타이핑이 가로채인다.
        setCaptureHint(true);
        return;
      }
      setCaptureHint(false);
      setShortcutOverride(capturing, chord);
      setCapturing(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      setShortcutCaptureActive(false);
    };
  }, [capturing, setShortcutOverride]);

  const FILTERS: { id: ShortcutStatusFilter; label: string }[] = [
    { id: "all", label: "All" },
    { id: "modified", label: "Modified" },
    { id: "unassigned", label: "Unassigned" },
    { id: "conflicts", label: "Conflicts" },
  ];

  return (
    <>
      <PageTitle title={t("settings.shortcuts.title")} desc={t("settings.shortcuts.description")} />
      <div className="flex w-full flex-col">
        {/* 제목과 첫 그룹 사이 32px — 바깥 래퍼의 gap-6(24px)에 pt-2를 더한 값 */}
        <section className="flex w-full flex-col pt-2 pb-6">
        <FlatRow
          title={t("settings.shortcuts.priority.title")}
          desc={t("settings.shortcuts.priority.desc")}
        >
          <SelectField
            value={termFirst ? "terminal" : "app"}
            onValueChange={(v) => setUi({ shortcutTerminalFirst: v === "terminal" })}
            className="w-[180px]"
          >
            <SelectOption value="app">
              {t("settings.shortcuts.priority.dureFirst")}
            </SelectOption>
            <SelectOption value="terminal">
              {t("settings.shortcuts.priority.terminalFirst")}
            </SelectOption>
          </SelectField>
        </FlatRow>
        </section>

        <section className="flex w-full flex-col gap-6 border-t border-border py-6">
        <FlatRow
          title={t("settings.shortcuts.list.title")}
          desc={t("settings.shortcuts.list.desc")}
        />

        <div className="flex gap-6">
          {/* 왼쪽: 검색 + 상태 필터 */}
          <div className="flex w-[230px] shrink-0 flex-col gap-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-foreground">{t("settings.shortcuts.search.title")}</span>
              <span className="text-xs text-muted-foreground">
                {shown.length}/{counts.all}
              </span>
            </div>
            <SearchField
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("settings.shortcuts.search.placeholder")}
              inputClassName="h-8"
            />
            {/* Mockup 2527:84810 gives this list the same vocabulary as the
                settings sidebar — group label (h-8) + menu button (h-8,
                rounded-md) + count badge on the right. The filter list is
                ultimately a "vertical list for picking an item" too, so reusing
                the shape users already learned is right. */}
            <div className="flex flex-col pt-2">
              <div className="flex h-8 items-center px-2">
                <span className="text-[11px] font-medium text-muted-foreground">{t("settings.shortcuts.statusHeader")}</span>
              </div>
              <div className="flex flex-col gap-0.5">
                {FILTERS.map((f) => (
                  <button
                    type="button"
                    key={f.id}
                    onClick={() => setStatus(f.id)}
                    aria-pressed={status === f.id}
                    className={cn(
                      "flex h-8 items-center gap-2 rounded-md px-2 text-left text-xs",
                      status === f.id
                        ? "bg-glass-tint-selected text-foreground"
                        : "text-foreground hover:bg-glass-tint-hover",
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">{f.label}</span>
                    <span className="flex h-5 shrink-0 items-center justify-center px-1 text-[11px] text-muted-foreground">
                      {counts[f.id]}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* 오른쪽: 그룹별 단축키 */}
          <div className="flex min-w-0 flex-1 flex-col gap-4">
            {groups.length === 0 && (
              <p className="text-xs text-muted-foreground">{t("settings.shortcuts.search.noMatch")}</p>
            )}
            {groups.map((g) => (
              <div key={g.group} className="flex flex-col">
                <span className="pb-1 text-sm font-medium text-foreground">{t(g.group)}</span>
                {g.items.map((s) => (
                  <div
                    key={s.id}
                    className="flex items-center gap-3 border-b border-border pt-[13px] pb-[14px] last:border-0"
                  >
                    {/* Mockup 2527:84810 puts the scope chip right next to the
                        command name — "where this command belongs" reads like part
                        of the name, and the right edge stays clear so keycaps line
                        up vertically. */}
                    <span className="flex min-w-0 flex-1 items-center gap-2">
                    <span className="min-w-0 truncate text-sm text-foreground">
                      {t(s.command)}
                      {conflicts.has(s.id) && (
                        <span className="ml-1.5 rounded bg-status-warn/15 px-1 text-[9px] text-status-warn">
                          {t("common.conflict")}
                        </span>
                      )}
                    </span>
                    <span className="flex shrink-0 items-center gap-1 rounded-md border border-input bg-glass-chrome px-2 py-0.5 text-[10px] text-muted-foreground">
                      {s.source === "terminal" ? (
                        <>
                          <TerminalSquare className="size-3" /> {t("common.terminal")}
                        </>
                      ) : (
                        t("Dure")
                      )}
                    </span>
                    </span>
                    {s.rebindable ? (
                      <Titled title={t("settings.shortcuts.capture.hint")}>
                        <button
                          type="button"
                          onClick={() => {
                            setCaptureHint(false);
                            setCapturing(s.id);
                          }}
                          className="flex shrink-0 items-center gap-1 rounded px-1 py-0.5 hover:bg-accent"
                        >
                          {capturing === s.id ? (
                            <span className="text-[11px] text-status-run">
                              {captureHint ? t("settings.shortcuts.capture.includeModifier") : t("settings.shortcuts.capture.pressKey")}
                            </span>
                          ) : s.unassigned ? (
                            <span className="text-[11px] text-muted-foreground">{t("settings.shortcuts.unbound")}</span>
                          ) : (
                            s.keys.map((seq, i) => (
                              <span key={i} className="flex items-center gap-1">
                                {seq.map((k, j) => (
                                  <KeyCap key={j} label={k} />
                                ))}
                              </span>
                            ))
                          )}
                        </button>
                      </Titled>
                    ) : (
                      <span className="flex shrink-0 items-center gap-1 px-1 py-0.5">
                        {s.keys.map((seq, i) => (
                          <span key={i} className="flex items-center gap-1">
                            {seq.map((k, j) => (
                              <KeyCap key={j} label={k} />
                            ))}
                          </span>
                        ))}
                      </span>
                    )}
                    {s.rebindable && (
                      <span className="flex shrink-0 items-center">
                        <IconButton
                          onClick={() => setShortcutOverride(s.id, null)}
                          title={t("settings.shortcuts.unassign")}
                          className="hover:text-destructive"
                          disabled={s.unassigned}
                        >
                          <X />
                        </IconButton>
                        <IconButton
                          onClick={() => resetShortcutOverride(s.id)}
                          title={t("settings.shortcuts.resetDefault")}
                          disabled={!s.modified}
                        >
                          <RotateCw />
                        </IconButton>
                      </span>
                    )}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
        </section>
      </div>
    </>
  );
}
