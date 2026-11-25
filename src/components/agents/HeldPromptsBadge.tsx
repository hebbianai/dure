import { SessionStatusBadge } from "@/components/sessions/SessionListRow";
import { useNowTick } from "@/components/spaces/useNowTick";
import { heldPromptsOf } from "@/lib/agents/heldPrompts";
import { t } from "@/lib/i18n";
import type { HmuxAgentRuntimeState } from "@/lib/ipc/hmuxContracts";
import { formatRelativeAge } from "@/lib/ui/relativeAge";

/** Messages the Host could not hand to this agent because unsent text stands
 * at its prompt, from the Host's own count. Dure never sends that text for the
 * person (#603), so the pane says why an agent that looks idle is not reading
 * its inbox. */
export function HeldPromptsBadge({
	runtime,
}: {
	runtime: HmuxAgentRuntimeState | undefined;
}) {
	const held = heldPromptsOf(runtime);
	const now = useNowTick(held !== undefined);
	if (!held) return null;
	return (
		<SessionStatusBadge
			status={
				held.count === 1
					? t("agents.heldPrompts.status.one")
					: t("agents.heldPrompts.status.other", { n: held.count })
			}
			tone="attention"
			description={t("agents.heldPrompts.description", {
				age: formatRelativeAge(held.sinceUnixMs, now),
			})}
		/>
	);
}
