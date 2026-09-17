// 에이전트 추가 다이얼로그 왼쪽 레일 (시안 2256:29014).
//
// 호스트 하나를 고르면 오른쪽 위치 목록이 그 호스트 것만 남는다. 배지는 그
// 호스트에 등록된 프로젝트 수다(소유자 확인 2026-08-02).

import { Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import type { HostOption } from "@/lib/agents/addAgentForm";

export function HostRail({
  hosts,
  selectedHostId,
  onSelect,
  onAddHost,
}: {
  hosts: readonly HostOption[];
  selectedHostId: string | null;
  onSelect: (hostId: string | null) => void;
  onAddHost: () => void;
}) {
  return (
    // 시안 2256:29014 — 폭 200px, 오른쪽 헤어라인, 위 11px / 아래 16px.
    <div className="flex w-[200px] shrink-0 flex-col border-r border-glass-hairline px-4 pt-[11px] pb-4">
      <div className="flex min-h-0 flex-1 flex-col">
        {/* 2256:29017 SidebarGroupLabel — 11px medium muted, 높이 32px */}
        <div className="flex h-8 items-center px-2">
          <span className="min-w-0 flex-1 truncate text-meta leading-4 font-medium text-muted-foreground">
            {t("common.host")}
          </span>
        </div>
        {hosts.map((host) => {
          const selected = host.id === selectedHostId;
          return (
            <button
              key={host.id ?? "__local__"}
              type="button"
              aria-current={selected ? "true" : undefined}
              onClick={() => onSelect(host.id)}
              className={cn(
                "flex h-8 w-full items-center gap-2 rounded-md p-2 text-left",
                // 2256:29018 선택 상태는 glass tint, 라벨만 medium으로 올린다.
                selected
                  ? "bg-glass-tint-selected text-sidebar-accent-foreground"
                  : "text-sidebar-foreground hover:bg-glass-tint-hover",
              )}
            >
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-xs leading-none",
                  selected ? "font-medium" : "font-normal",
                )}
              >
                {/* 로컬 행의 이름만 우리가 만든 문구다 — SSH 호스트 이름은
                    사용자 데이터라 번역하지 않는다. */}
                {host.id === null ? t("common.local") : host.name}
              </span>
              {/* 2256:29018 Sidebar Badge — 프로젝트 수 */}
              <span className="shrink-0 text-meta leading-4 font-medium text-muted-foreground/70">
                {host.projectCount}
              </span>
            </button>
          );
        })}
      </div>
      {/* 2256:29022 — SSH 호스트 추가 */}
      <button
        type="button"
        onClick={onAddHost}
        className="flex h-8 items-center gap-2 rounded-md px-2 text-left text-meta text-muted-foreground hover:bg-glass-tint-hover"
      >
        <Plus className="size-3 shrink-0" />
        {t("common.addSshHost")}
      </button>
    </div>
  );
}
