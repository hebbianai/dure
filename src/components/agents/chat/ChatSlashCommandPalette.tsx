import { useEffect, useRef } from "react";
import type { ChatSlashCommand } from "@/lib/agents/chat/slashCommands";
import { t } from "@/lib/i18n";
import { MENU_SURFACE_CLASS } from "@/lib/ui/menuSurface";
import { cn } from "@/lib/utils";

export function chatSlashCommandOptionId(listId: string, index: number) {
	return `${listId}-option-${index}`;
}

/** The `/` menu above the composer. The textarea keeps focus and owns the
 * keyboard (combobox pattern); this list only renders and takes pointer picks. */
export function ChatSlashCommandPalette({
	id,
	commands,
	activeIndex,
	onActiveIndexChange,
	onChoose,
}: {
	id: string;
	commands: readonly ChatSlashCommand[];
	activeIndex: number;
	onActiveIndexChange(index: number): void;
	onChoose(command: ChatSlashCommand): void;
}) {
	const activeRef = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		activeRef.current?.scrollIntoView?.({ block: "nearest" });
	}, [activeIndex]);
	return (
		<div
			id={id}
			role="listbox"
			aria-label={t("agents.chat.commandsLabel")}
			className={cn(MENU_SURFACE_CLASS, "max-h-64 overflow-y-auto text-xs")}
		>
			{commands.map((command, index) => {
				const active = index === activeIndex;
				return (
					<div
						key={`${command.kind}:${command.name}`}
						ref={active ? activeRef : undefined}
						id={chatSlashCommandOptionId(id, index)}
						role="option"
						aria-selected={active}
						className={cn(
							"my-0.5 flex min-w-0 cursor-default items-baseline gap-2 rounded-sm px-2 py-1",
							active && "bg-glass-menu-hover",
						)}
						// Keep focus in the textarea; a pick must not blur the draft.
						onMouseDown={(event) => event.preventDefault()}
						onMouseMove={() => {
							if (!active) onActiveIndexChange(index);
						}}
						onClick={() => onChoose(command)}
					>
						<span className="shrink-0 font-mono text-foreground">
							/{command.name}
						</span>
						{command.argumentHint && (
							<span className="shrink-0 font-mono text-muted-foreground">
								{command.argumentHint}
							</span>
						)}
						{command.description && (
							<span className="min-w-0 truncate text-muted-foreground">
								{command.description}
							</span>
						)}
					</div>
				);
			})}
		</div>
	);
}
