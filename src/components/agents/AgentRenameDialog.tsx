// Agent display-name rename dialog — one definition of the rename copy and
// save wiring, shared by the agent context menus. Callers keep the open state
// so the dialog stays mounted outside the (already unmounted) menu tree.

import { NameEditDialog } from "@/components/workspace/NameEditDialog";
import { renameAgentDisplayName } from "@/lib/agents/agentDisplayNameState";
import { t } from "@/lib/i18n";
import type { Agent } from "@/types";

export function AgentRenameDialog({
  agent,
  open,
  onOpenChange,
}: {
  agent: Agent;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <NameEditDialog
      open={open}
      title={t("common.agentRename.title")}
      description={t("common.agentRename.description")}
      value={agent.displayName ?? ""}
      placeholder={agent.name}
      onOpenChange={onOpenChange}
      onSave={(value) => renameAgentDisplayName(agent.id, value)}
    />
  );
}
