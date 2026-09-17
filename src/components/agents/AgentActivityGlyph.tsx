import { ProviderGlyph, TerminalGlyph } from "@/components/agents/ProviderLogo";

import { ActivityDot } from "@/components/agents/StatusBits";
import { DureLoader } from "@/components/ui/dure-loader";
import type { AgentDisplayState } from "@/lib/agents/agentStateModel";
import { cn } from "@/lib/utils";
import type { Provider } from "@/types";

/** States the slot says nothing extra about: working is the loader itself,
 * and waiting is the ordinary green resting state — "just normal, no
 * need to show it" (owner decision 2026-09-03). A badge is for what asks for
 * a person or marks a departure: input, blocked, error, connecting, exited. */
const QUIET_STATES: ReadonlySet<AgentDisplayState> = new Set([
	"working",
	"waiting",
]);

/** The 12px slot that says who a session is and whether it is busy — the
 * one rule every session surface shares (owner decision 2026-09-03: the pane
 * header and both Spaces rows used to spend a separate 5px dot on a state the
 * slot can carry).
 *
 * - working → DureLoader in place of the logo; nothing else moves. It sits
 *   on the same tone as the resting glyphs: muted by default, or the
 *   surrounding title's tone when the caller sets text-inherit.
 * - otherwise → the provider logo (TerminalGlyph for a plain terminal).
 * - the states that ask for a person or mark a departure — input, blocked,
 *   error, connecting, exited — stay visible as a 5px ActivityDot badge on
 *   the slot's lower-right corner, unread ring included: activity is not the
 *   information, the need to step in is (SOUL §5.1). The green resting
 *   waiting state and idle draw no badge. */
export function AgentActivityGlyph({
	provider,
	activity,
	unread,
	size = 12,
	className,
}: {
	provider?: Provider | null;
	activity?: AgentDisplayState;
	unread?: boolean;
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
			{activity === "working" ? (
				<DureLoader decorative size={size} />
			) : provider ? (
				<ProviderGlyph provider={provider} className="size-full text-inherit" />
			) : (
				<TerminalGlyph className="size-full" />
			)}
			{activity && !QUIET_STATES.has(activity) && (
				<ActivityDot
					activity={activity}
					unread={unread}
					className="absolute -right-0.5 -bottom-0.5 block size-[5px]"
				/>
			)}
		</span>
	);
}
