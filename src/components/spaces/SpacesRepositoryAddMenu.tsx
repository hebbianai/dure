// The '+' end of the repository head row's quick add — every action the row
// can take, including the ones its inline buttons had no room for.
//
// The menu opens on hover, not on click (HoverMenuButton): picking an item is
// already one deliberate choice, and a click just to reveal the menu made the
// action two steps deep.
//
// Provider entries start the agent in the repository's *own* checkout. The
// dialog entry stays for everything that needs a decision — another folder, a
// worktree, a branch — so the fast path never has to grow options.

import { Plus, SlidersHorizontal } from "lucide-react";
import { DureLoader } from "@/components/ui/dure-loader";
import { memo } from "react";
import { ProviderGlyph, TerminalGlyph } from "@/components/agents/ProviderLogo";
import {
	DropdownMenuItem,
	DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { HoverMenuButton } from "@/components/ui/hover-menu-button";
import { t } from "@/lib/i18n";
import type { RepositoryQuickAddTarget } from "@/lib/spaces/repositoryQuickAdd";
import { PROVIDERS, type Provider } from "@/types";

export const SpacesRepositoryAddMenu = memo(function SpacesRepositoryAddMenu({
	target,
	providers,
	busy,
	onAddTerminal,
	onStartAgent,
	onAddAgentWithOptions,
}: {
	target: RepositoryQuickAddTarget;
	/** Every provider that can be started — the inline row shows a prefix. */
	providers: readonly Provider[];
	/** A start is in flight; the row's spinner lives on this trigger. */
	busy: boolean;
	onAddTerminal(target: RepositoryQuickAddTarget): void;
	onStartAgent(provider: Provider): void;
	onAddAgentWithOptions(target: RepositoryQuickAddTarget): void;
}) {
	return (
		<HoverMenuButton
			title={t("spaces.repository.addTo", { name: target.label })}
			icon={busy ? <DureLoader decorative /> : <Plus />}
			triggerClassName="-my-[3px] shrink-0"
			contentClassName="w-56"
		>
			<DropdownMenuItem onSelect={() => onAddTerminal(target)}>
				<TerminalGlyph className="size-3.5" />
				<span className="text-xs">{t("common.openTerminal")}</span>
			</DropdownMenuItem>
			<DropdownMenuSeparator />
			{providers.map((provider) => (
				<DropdownMenuItem
					key={provider}
					// A start already in flight owns the next agent name for this
					// repository; a second one would race it onto the same name.
					// The spinner on the trigger says why.
					disabled={busy}
					onSelect={() => onStartAgent(provider)}
				>
					<ProviderGlyph provider={provider} />
					<span className="text-xs">
						{t("spaces.repository.startWith", {
							label: PROVIDERS[provider].label,
						})}
					</span>
				</DropdownMenuItem>
			))}
			<DropdownMenuSeparator />
			<DropdownMenuItem onSelect={() => onAddAgentWithOptions(target)}>
				<SlidersHorizontal />
				<span className="text-xs">{t("spaces.repository.addWithOptions")}</span>
			</DropdownMenuItem>
		</HoverMenuButton>
	);
});
