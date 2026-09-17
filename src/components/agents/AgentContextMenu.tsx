import { useState, type ReactNode } from "react";
import { message as messageDialog } from "@tauri-apps/plugin-dialog";
import { GitFork, PencilLine } from "lucide-react";
import { t } from "@/lib/i18n";
import { PROVIDERS, type Agent, type Provider } from "@/types";
import { ProviderGlyph } from "@/components/agents/ProviderLogo";
import { useAvailableProviders } from "@/lib/agents/agentInstalls";
import { forkAgent } from "@/lib/agents/fork";
import { providerForkInheritsConversation } from "@/lib/agents/providerForkCapability";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { AgentRenameDialog } from "@/components/agents/AgentRenameDialog";
import {
  agentDisplayName,
} from "@/lib/agents/agentDisplayName";

export type AgentForkPresenter = (forkedAgent: Agent) => void | Promise<void>;

/** 세션 포크 액션 — 우클릭 메뉴와 점세개(…) 드롭다운이 공유한다. */
function useAgentFork(agent: Agent, presentFork: AgentForkPresenter) {
  const [busy, setBusy] = useState(false);

  const fork = async (provider: Provider) => {
    if (busy) return;
    setBusy(true);
    try {
      let forked: Agent;
      try {
        forked = await forkAgent(agent.id, provider);
      } catch (e) {
        await messageDialog(t("common.forkFailed", { e: String(e) }), {
          kind: "error",
        });
        return;
      }
      try {
        await presentFork(forked);
      } catch {
        await messageDialog(
          t("workspace.agentWindow.forkPresentationFailed"),
          { kind: "error" },
        );
      }
    } finally {
      setBusy(false);
    }
  };
  return { fork, busy };
}

/** 에이전트 우클릭 메뉴 — 새 worktree를 만들고, 검증된 provider-native
 *  fork adapter가 있을 때만 최신 대화를 독립적으로 분기한다. */
export function AgentContextMenu({
  agent,
  children,
  presentFork,
}: {
  agent: Agent;
  children: ReactNode;
  presentFork: AgentForkPresenter;
}) {
  const { fork, busy } = useAgentFork(agent, presentFork);
  const availableProviders = useAvailableProviders();
  const [renameOpen, setRenameOpen] = useState(false);

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent className="w-60">
          <ContextMenuLabel>{agentDisplayName(agent)}</ContextMenuLabel>
          <ContextMenuItem
            onSelect={() => window.setTimeout(() => setRenameOpen(true), 0)}
          >
            <PencilLine /> {t("common.agentRename.menu")}
          </ContextMenuItem>
          <ContextMenuLabel className="flex items-center gap-1.5">
            <GitFork className="size-3" /> {t("common.sessionForkNewWorktree")}
          </ContextMenuLabel>
          {availableProviders.map((p) => (
            <ContextMenuItem key={p} disabled={busy} onClick={() => fork(p)}>
              <ProviderGlyph provider={p} />
              <span className="text-xs">
                {t("agents.fork.toLabel", { label: PROVIDERS[p].label })}
                <span className="text-muted-foreground">
                  {providerForkInheritsConversation(agent.provider, p)
                    ? ` · ${t("common.conversationFork")}`
                    : ` · ${t("common.newConversation")}`}
                </span>
              </span>
            </ContextMenuItem>
          ))}
        </ContextMenuContent>
      </ContextMenu>
      <AgentRenameDialog agent={agent} open={renameOpen} onOpenChange={setRenameOpen} />
    </>
  );
}
