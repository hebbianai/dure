import { ProviderGlyph, TerminalGlyph } from "@/components/agents/ProviderLogo";

import { ActivityDot } from "@/components/agents/StatusBits";
import { DureLoader } from "@/components/ui/dure-loader";
import type { AgentDisplayState } from "@/lib/agents/agentStateModel";
import { AGENT_STATUS_MARK } from "@/lib/agents/agentStatusMark";
import { cn } from "@/lib/utils";
import type { Provider } from "@/types";

/** The 12px slot that says who a session is and what it is doing — the one
 * rule every session surface shares (owner decision 2026-09-03: the pane
 * header and both Spaces rows used to spend a separate 5px dot on a state the
 * slot can carry).
 *
 * - The provider logo (TerminalGlyph for a plain terminal) always holds the
 *   slot. It sits on the muted tone by default, or the surrounding title's
 *   tone when the caller sets text-inherit.
 * - The state rides on the logo's lower-right corner as a 5px ActivityDot,
 *   unread ring included, whenever the status mark table says it belongs on
 *   a glyph: working's green breathing dot, the states that ask for a person
 *   or mark a departure. A finished turn is the ordinary resting state and
 *   draws nothing (owner decision 2026-09-03: "just normal, no need to show
 *   it").
 * - `loading` is Dure's own wait, not the agent's state — a saved session
 *   being opened: the loader stands in for the logo until it opens. */
export function AgentActivityGlyph({
	provider,
	activity,
	unread,
	loading = false,
	size = 12,
	className,
}: {
	provider?: Provider | null;
	activity?: AgentDisplayState;
	unread?: boolean;
	loading?: boolean;
	/** 12 is the pane header's size and the default; the sidebar's rows take
	 *  14, the size every other glyph in the sidebar draws at — the Files
	 *  tab's folders and files, the repository folder, the '+' — so a provider
	 *  mark is not the one small thing on its row (owner call 2026-09-14).
	 *  The loader follows the same number. */
	size?: 12 | 14;
	className?: string;
}) {
	return (
		<span
			className={cn(
				"relative flex shrink-0 text-muted-foreground",
				size === 14 ? "size-3.5" : "size-3",
				className,
			)}
		>
			{loading ? (
				<DureLoader decorative size={size} />
			) : provider ? (
				<ProviderGlyph provider={provider} className="size-full text-inherit" />
			) : (
				<TerminalGlyph className="size-full" />
			)}
			{activity && AGENT_STATUS_MARK[activity].onGlyph && (
				<ActivityDot
					activity={activity}
					unread={unread}
					className="absolute -right-0.5 -bottom-0.5 block size-[5px]"
				/>
			)}
		</span>
	);
}
