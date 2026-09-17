import { memo, useState } from "react";
import { message as messageDialog } from "@tauri-apps/plugin-dialog";
import { EyeOff } from "lucide-react";
import { AgentItemRow } from "@/components/sidebar/SidebarItems";
import { ProviderGlyph } from "@/components/agents/ProviderLogo";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { RowMenuButton } from "@/components/ui/icon-button";
import {
  detectedWorktreeLastActivity,
  detectedWorktreeSessionCount,
  type DetectedWorktreeSession,
} from "@/lib/spaces/detectedWorktreeSessions";
import { t } from "@/lib/i18n";
import { formatRelativeAge } from "@/lib/ui/relativeAge";
import { cn } from "@/lib/utils";
import { PROVIDERS, type Provider } from "@/types";

/** A worktree with no recorded activity names no time. */
function timeAgo(timestamp?: number): string {
  return timestamp ? formatRelativeAge(timestamp) : "";
}

/** 다른 도구에서 만든 worktree를 등록하고 정확한 provider 세션으로 이어받는다. */
export const DetectedWorktreeRow = memo(function DetectedWorktreeRow({
  candidate,
  onAdopt,
  onHide,
}: {
  candidate: DetectedWorktreeSession;
  onAdopt: (
    candidate: DetectedWorktreeSession,
    provider: Provider,
  ) => Promise<void>;
  onHide: (candidate: DetectedWorktreeSession) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const adopt = async (provider: Provider) => {
    if (busy) return;
    setBusy(true);
    try {
      await onAdopt(candidate, provider);
    } catch (error) {
      await messageDialog(t("spaces.worktree.resumeFailed", { e: String(error) }), {
        kind: "error",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <AgentItemRow
      provider={candidate.provider}
      name={candidate.name}
      branch={[candidate.projectName, candidate.worktree.branch]
        .filter(Boolean)
        .join(" · ")}
      activity="exited"
      menuOpen={menuOpen}
      className={cn(busy && "pointer-events-none opacity-60")}
      data-detected-worktree={candidate.worktree.path}
      title={t("spaces.worktree.externalRowTitle", {
        label: PROVIDERS[candidate.provider].label,
        when: timeAgo(candidate.lastActivityAt),
      })}
      onClick={() => void adopt(candidate.provider)}
      menu={
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <RowMenuButton title={t("spaces.worktree.resumeOptions")} className="cursor-pointer" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-60">
            {(["claude", "codex"] as const).map((provider) => {
              const count = detectedWorktreeSessionCount(
                candidate.worktree,
                provider,
              );
              const lastActivity = detectedWorktreeLastActivity(
                candidate.worktree,
                provider,
              );
              return (
                <DropdownMenuItem
                  key={provider}
                  disabled={busy}
                  onSelect={() => void adopt(provider)}
                >
                  <ProviderGlyph provider={provider} />
                  <span className="text-xs">
                    {t("spaces.worktree.resumeWith", {
                      label: PROVIDERS[provider].label,
                    })}
                    <span className="text-muted-foreground">
                      {count > 0 ? (
                        <>
                          {` · ${t("spaces.worktree.sessionCount", { count })} (`}
                          <span className="font-mono">{timeAgo(lastActivity)}</span>
                          {")"}
                        </>
                      ) : (
                        ` · ${t("common.newConversation")}`
                      )}
                    </span>
                  </span>
                </DropdownMenuItem>
              );
            })}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onHide(candidate)}>
              <EyeOff />
              <span className="text-xs">{t("common.hideFromList")}</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      }
    />
  );
});
