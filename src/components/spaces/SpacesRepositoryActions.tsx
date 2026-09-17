// Repository head-row actions — the hover cluster that starts a terminal or an
// agent in that repository without crossing a dialog first.
//
// Shape: [terminal] [agent] [agent] [agent] [+]. The first four are the whole
// action, one click each; the '+' holds everything that did not fit plus the
// dialog for anything needing a decision (another folder, a worktree, a
// branch), so the fast path never has to grow options.
//
// Two rules keep it from crowding the row it lives in:
//
//  * Hidden by display, not opacity. An invisible-but-laid-out cluster would
//    permanently truncate the repository name to make room for buttons nobody
//    is looking at — the same reason AgentItemRow's menu slot toggles `hidden`
//    (SidebarItems.tsx). At rest the name gets the whole row.
//  * The agent buttons drop one at a time as the sidebar narrows (container
//    queries below), so the name keeps roughly 90px whatever the width.
//    Whatever drops out is still in the '+' menu, which never drops.

import { TerminalGlyph } from "@/components/agents/ProviderLogo";
import { memo, useCallback, useState } from "react";
import { ProviderGlyph } from "@/components/agents/ProviderLogo";
import { SpacesRepositoryAddMenu } from "@/components/spaces/SpacesRepositoryAddMenu";
import { IconButton } from "@/components/ui/icon-button";
import { useQuickStartProviders } from "@/lib/agents/agentInstalls";
import { t } from "@/lib/i18n";
import {
	INLINE_QUICK_ADD_PROVIDER_LIMIT,
	type RepositoryQuickAddTarget,
} from "@/lib/spaces/repositoryQuickAdd";
import { cn } from "@/lib/utils";
import { PROVIDERS, type Provider } from "@/types";

/** Width at which each button starts fitting, measured on the rows container
 *  the pane already declares (`@container/space-open-rows`, SpacesPane).
 *
 *  A button is 24px + 2px gap and the row's own chrome (padding, folder icon,
 *  gaps) is ~31px, so each threshold is the width at which that button still
 *  leaves the name ~90px. Stated additively (`@min-…:flex`) so an unforeseen
 *  width shows fewer buttons rather than overflowing the row.
 *
 *  Static strings on purpose — Tailwind scans source text, so a computed class
 *  name would simply not exist in the stylesheet. */
const TERMINAL_SLOT_CLASS = "hidden @min-[172px]/space-open-rows:flex";
const PROVIDER_SLOT_CLASS = [
	"hidden @min-[198px]/space-open-rows:flex",
	"hidden @min-[224px]/space-open-rows:flex",
	"hidden @min-[250px]/space-open-rows:flex",
] as const;

/** The slide itself: a button rests at zero width and opens to 24px when the
 *  pointer reaches the rail, or while a control in the rail has visible
 *  (keyboard) focus. Width (not opacity alone) is what makes it read as
 *  sliding out of the '+' — an opacity-only reveal would hold the space open
 *  the whole time and truncate the repository name for nothing.
 *
 *  Collapsing is undelayed while opening staggers, so the row closes crisply
 *  and opens in a run. `motion-reduce` drops the movement, not the buttons. */
const SLIDE_CLASS =
	"w-0 overflow-hidden opacity-0 transition-[width,opacity,margin] duration-150 ease-out motion-reduce:transition-none group-hover/rail:ml-0.5 group-hover/rail:w-6 group-hover/rail:opacity-100 group-has-[:focus-visible]/rail:ml-0.5 group-has-[:focus-visible]/rail:w-6 group-has-[:focus-visible]/rail:opacity-100";

/** Opening stagger, left to right, so the buttons unfurl instead of blinking
 *  on together. Static strings — Tailwind never sees a computed class. */
const SLIDE_DELAY_CLASS = [
	"group-hover/rail:delay-0 group-has-[:focus-visible]/rail:delay-0",
	"group-hover/rail:delay-[30ms] group-has-[:focus-visible]/rail:delay-[30ms]",
	"group-hover/rail:delay-[60ms] group-has-[:focus-visible]/rail:delay-[60ms]",
	"group-hover/rail:delay-[90ms] group-has-[:focus-visible]/rail:delay-[90ms]",
] as const;

/** While a start runs the rail stays open: the spinner is on the '+', and a
 *  rail that collapsed under it would hide which repository is working. */
const SLIDE_OPEN_CLASS = "ml-0.5 w-6 opacity-100";

export interface SpacesRepositoryActionHandlers {
	/** Opens a terminal in the repository's folder (remote when it is remote). */
	onAddTerminal(target: RepositoryQuickAddTarget): void;
	/** Starts the provider in the repository's checkout. Rejections surface on
	 *  the caller's side; this component only tracks the pending state. */
	onAddAgent(
		target: RepositoryQuickAddTarget,
		provider: Provider,
	): Promise<void>;
	/** The full add-agent dialog, prefilled with this repository. */
	onAddAgentWithOptions(target: RepositoryQuickAddTarget): void;
}

export const SpacesRepositoryActions = memo(function SpacesRepositoryActions({
	target,
	onAddTerminal,
	onAddAgent,
	onAddAgentWithOptions,
}: {
	target: RepositoryQuickAddTarget;
} & SpacesRepositoryActionHandlers) {
	const { available, quick } = useQuickStartProviders(
		INLINE_QUICK_ADD_PROVIDER_LIMIT,
	);
	const [busy, setBusy] = useState(false);

	const startAgent = useCallback(
		(provider: Provider) => {
			// A start already in flight owns the next agent name for this
			// repository; a second one would race it onto the same name.
			if (busy) return;
			setBusy(true);
			void onAddAgent(target, provider).finally(() => setBusy(false));
		},
		[busy, onAddAgent, target],
	);

	return (
		// Two stages, and the row only ever pays for the second one it needs.
		//
		// Row hover puts the rail up ('+' alone). `has-[[data-state=open]]` keeps
		// it up while its menu is open and the pointer has already moved off;
		// `busy` keeps it up while a start runs, so the spinner cannot vanish
		// mid-flight; a visibly focused control inside (`:focus-visible`) is the
		// keyboard's way in. Not `:focus-within`: closing the '+' menu hands
		// focus back to its trigger, and with the pointer long gone that focus
		// kept the rail up until the next click anywhere (owner report
		// 2026-09-03). Programmatic focus after mouse use is not focus-visible,
		// keyboard focus is — which is exactly the split wanted here.
		//
		// The quick buttons then slide out when the pointer comes near the '+' —
		// `pl-10` is that proximity, a transparent 40px approach lane in front of
		// the rail (a hover zone, not a pointer-distance measurement: no JS runs
		// per mouse move in a list this long).
		<div
			className={cn(
				"group/rail ml-auto hidden shrink-0 items-center pl-10 group-hover/label:flex group-has-[:focus-visible]/label:flex has-[[data-state=open]]:flex",
				busy && "flex",
			)}
		>
			<IconButton
				title={t("common.openTerminal")}
				// 14px, the IconButton default: an outline glyph like the folder
				// and the '+' on either side of it, so it weighs the same as they
				// do. It was held at 12 with the provider marks, which are filled
				// and sit one step smaller on purpose (below); an outline at 12
				// beside outlines at 14 just read as the odd one (owner report
				// 2026-09-14).
				className={cn(
					"-my-[3px] shrink-0",
					TERMINAL_SLOT_CLASS,
					SLIDE_CLASS,
					SLIDE_DELAY_CLASS[0],
					busy && SLIDE_OPEN_CLASS,
				)}
				onClick={(event) => {
					event.stopPropagation();
					onAddTerminal(target);
				}}
			>
				<TerminalGlyph />
			</IconButton>
			{quick.map((provider, index) => (
				<IconButton
					key={provider}
					title={t("spaces.repository.startWith", {
						label: PROVIDERS[provider].label,
					})}
					disabled={busy}
					className={cn(
						"-my-[3px] shrink-0",
						PROVIDER_SLOT_CLASS[index],
						SLIDE_CLASS,
						SLIDE_DELAY_CLASS[index + 1],
						busy && SLIDE_OPEN_CLASS,
					)}
					onClick={(event) => {
						event.stopPropagation();
						startAgent(provider);
					}}
				>
					{/* 14px, the same as the folder, the terminal and the '+' on this
					    row — and as the session rows draw these marks now. They sat
					    at 12 from 2026-09-10 on the grounds that a filled mark
					    outweighs an outline at the same size; the owner took the
					    trade the other way on 2026-09-14, one size for every glyph on
					    the row over matched ink. ProviderGlyph's own default is
					    12px, tuned for menu rows. */}
					<ProviderGlyph provider={provider} className="size-3.5" />
				</IconButton>
			))}
			<SpacesRepositoryAddMenu
				target={target}
				providers={available}
				busy={busy}
				onAddTerminal={onAddTerminal}
				onStartAgent={startAgent}
				onAddAgentWithOptions={onAddAgentWithOptions}
			/>
		</div>
	);
});
