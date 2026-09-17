// 워크트리 지정 방식 탭 + 검색 입력 (시안 2256:29056~29061).
//
// 탭 넷은 "이 워크트리를 무엇으로 만들 것인가"를 고르는 네 가지 길이다.
// 스마트/브랜치/이름은 기존 WorktreeModeChoice에 그대로 대응하고(addAgentForm),
// Github만 gh 조회를 거쳐 브랜치 이름을 만들어 낸다.

import { CaseSensitive, GitBranch, Sparkles } from "lucide-react";
// lucide는 Github 글리프를 내보내지 않는다 — 사이드바 레일이 쓰는 커스텀 아이콘을
// 그대로 재사용한다(같은 제품 안에서 GitHub 표시가 둘로 갈리면 안 된다).
import { GithubRailIcon } from "@/components/sidebar/RailIcons";
import { SearchField } from "@/components/ui/search-field";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import {
  searchPlaceholderForTab,
  worktreeTabLabel,
  type WorktreeTab,
} from "@/lib/agents/addAgentForm";
import type { GhWorkItem } from "@/lib/github/gh";

// Labels resolve through worktreeTabLabel() at render time — module scope
// would freeze the boot language.
const TABS: readonly {
  id: WorktreeTab;
  icon: React.ElementType<{ className?: string }>;
}[] = [
  { id: "smart", icon: Sparkles },
  { id: "github", icon: GithubRailIcon },
  { id: "branch", icon: GitBranch },
  { id: "name", icon: CaseSensitive },
];

export function WorktreeTabs({
  tab,
  onTabChange,
  query,
  onQueryChange,
  suggestions,
  onPickSuggestion,
  hint,
  hideModeTabs = false,
}: {
  tab: WorktreeTab;
  onTabChange: (tab: WorktreeTab) => void;
  query: string;
  onQueryChange: (query: string) => void;
  /** 브랜치 이름들(브랜치 탭) 또는 gh 작업 항목(Github 탭) */
  suggestions: readonly (string | GhWorkItem)[];
  onPickSuggestion: (value: string | GhWorkItem) => void;
  /** 인증 안내 등 — 있으면 입력 아래에 보인다 */
  hint?: { text: string; tone: "muted" | "warn" } | null;
  /** 기본 모드 간소화(2026-08-31): smart 입력만 남기고 탭 스트립을 접는다 —
   * smart가 브랜치/이름 탭의 동작을 이미 포괄한다. */
  hideModeTabs?: boolean;
}) {
  return (
    <div className="flex w-full flex-col gap-2">
      {/* 2256:29056 — 활성 탭만 1.5px 밑줄, 나머지는 투명 2px로 자리만 잡는다 */}
      {!hideModeTabs && (
      <div className="flex w-full items-start gap-0.5">
        {TABS.map(({ id, icon: Icon }) => {
          const active = id === tab;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onTabChange(id)}
              className={cn(
                "flex items-center gap-1.5 px-2.5 pt-1.5",
                active
                  ? "border-b-[1.5px] border-foreground pb-[7.5px]"
                  : "border-b-2 border-transparent pb-2",
              )}
            >
              <Icon
                className={cn(
                  "size-3 shrink-0",
                  active ? "text-foreground" : "text-muted-foreground",
                )}
              />
              <span
                className={cn(
                  "text-meta leading-none font-medium",
                  active ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {worktreeTabLabel(id)}
              </span>
            </button>
          );
        })}
      </div>
      )}

      {/* Keep the 36px form height on the shared search surface. */}
      <SearchField
        className="w-full"
        inputClassName="h-9"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        autoComplete="off"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        placeholder={t(searchPlaceholderForTab(tab))}
      />

      {hint && (
        <p
          className={cn(
            "text-meta leading-4 break-words",
            hint.tone === "warn" ? "text-status-warn" : "text-muted-foreground",
          )}
        >
          {hint.text}
        </p>
      )}

      {suggestions.length > 0 && (
        <div className="flex max-h-[132px] w-full flex-col overflow-y-auto rounded-md border border-glass-hairline">
          {suggestions.map((suggestion) => {
            const isItem = typeof suggestion !== "string";
            const key = isItem ? `${suggestion.kind}-${suggestion.number}` : suggestion;
            return (
              <button
                key={key}
                type="button"
                onClick={() => onPickSuggestion(suggestion)}
                className="flex items-center gap-2 px-3 py-1.5 text-left hover:bg-glass-tint-hover"
              >
                {isItem ? (
                  <>
                    <span className="shrink-0 font-mono text-meta text-muted-foreground">
                      #{suggestion.number}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs">
                      {suggestion.title}
                    </span>
                  </>
                ) : (
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">
                    {suggestion}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
