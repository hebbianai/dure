import { CirclePlus, Globe, Plus, Smartphone, Sparkles } from "lucide-react";
import { TerminalGlyph } from "@/components/agents/ProviderLogo";
import { memo } from "react";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { HoverMenuButton } from "@/components/ui/hover-menu-button";
import { readShortcutOverrides } from "@/components/agents/quickDispatch/useQuickDispatch";
import { Kbd } from "@/components/ui/kbd";
import { requestQuickDispatch } from "@/lib/agents/quickDispatch/quickDispatchActivation";
import { chordToLabels, shortcutChord } from "@/lib/settings/shortcutBindings";
import { t } from "@/lib/i18n";
import { openMobileSimulatorPanelOnDesktop } from "@/lib/workspace/dock/openMobileSimulatorPanel";
import { openBrowserPanelOnDesktop } from "@/lib/workspace/dock/openBrowserPanel";

/** The chord actually bound to quick dispatch, as keycap labels. An unbound or
 *  cleared shortcut renders no keycaps rather than a stale "⌘N". */
function quickDispatchKeys(): string[] {
	const chord = shortcutChord("quick-dispatch", readShortcutOverrides());
	return chord ? chordToLabels(chord) : [];
}

/** Shared menu for agent requests, agents, terminals, and the desktop browser.
 *
 *  Opens on hover (HoverMenuButton) — the same rule as the repository head
 *  row's quick add. Picking an item is already one deliberate choice, so a
 *  click just to reveal the menu made the action two steps deep. The click and
 *  keyboard paths are untouched. */
export const DesktopAddMenuButton = memo(function DesktopAddMenuButton({
	desktop,
	onAddAgent,
	onAddTerminal,
	triggerClassName = "opacity-0 transition-opacity group-hover/desktop:opacity-100 data-[state=open]:opacity-100",
}: {
	desktop: { readonly id: string; readonly name: string };
	onAddAgent: (desktopId: string) => void;
	onAddTerminal: (desktopId: string) => void;
	/** 그룹 헤더는 hover에서, Spaces 상단은 항상 트리거를 노출한다. */
	triggerClassName?: string;
}) {
	return (
		<HoverMenuButton
			title={t("spaces.desktop.addTo", { name: desktop.name })}
			icon={<Plus />}
			triggerClassName={triggerClassName}
			contentClassName="w-56"
		>
			{/* ⌘N's compose surface, reachable by pointer too (사용자 요청
			    2026-08-31). Same name the shortcut list and the overlay use — a
			    request, not a third word for the same thing.
			    The chord is a keycap in its own right-aligned slot, not text in
			    the label: parenthesised inside the label it crowded the panel's
			    right edge, and it is read from the binding so a rebound shortcut
			    cannot be advertised wrongly. */}
			<DropdownMenuItem onSelect={() => requestQuickDispatch()}>
				<Sparkles />
				<span className="text-xs">{t("spaces.desktop.newAgentRequest")}</span>
				<span className="ml-auto flex shrink-0 items-center gap-0.5 pl-3">
					{quickDispatchKeys().map((key) => (
						<Kbd key={key} size="sm">
							{key}
						</Kbd>
					))}
				</span>
			</DropdownMenuItem>
			<DropdownMenuItem onSelect={() => onAddAgent(desktop.id)}>
				<CirclePlus />
				<span className="text-xs">{t("common.startNewAgent")}</span>
			</DropdownMenuItem>
			<DropdownMenuItem onSelect={() => onAddTerminal(desktop.id)}>
				<TerminalGlyph className="size-3.5" />
				<span className="text-xs">{t("common.openTerminal")}</span>
			</DropdownMenuItem>
			<DropdownMenuItem onSelect={() => openBrowserPanelOnDesktop(desktop.id)}>
				<Globe />
				<span className="text-xs">{t("common.openBrowser")}</span>
			</DropdownMenuItem>
			<DropdownMenuItem
				onSelect={() => openMobileSimulatorPanelOnDesktop(desktop.id)}
			>
				<Smartphone />
				<span className="text-xs">{t("panels.mobile.title")}</span>
			</DropdownMenuItem>
		</HoverMenuButton>
	);
});
