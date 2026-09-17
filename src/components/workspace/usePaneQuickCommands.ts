import { SquareTerminal } from "lucide-react";
import { createElement, useState } from "react";
import type { PaneActionMenuSection } from "./PaneActionMenu";
import { t } from "@/lib/i18n";
import {
	capturePaneQuickCommandTarget,
	type PaneQuickCommandTarget,
} from "@/lib/workspace/pane/paneQuickCommandTarget";
import {
	moveQuickCommand,
	type QuickCommand,
	QuickCommandInputError,
} from "@/lib/workspace/pane/quickCommands";
import { useStore } from "@/store";

const EMPTY_COMMANDS: QuickCommand[] = [];

export function usePaneQuickCommands(surfaceId: string | undefined) {
	const commands = useStore(
		(state) => state.uiPrefs.quickCommands ?? EMPTY_COMMANDS,
	);
	const [editor, setEditor] = useState<QuickCommand | "new" | "manage" | null>(
		null,
	);
	const [target, setTarget] = useState<PaneQuickCommandTarget>();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const captureTarget = (open: boolean) => {
		if (open) {
			setError(undefined);
			const captured = surfaceId
				? capturePaneQuickCommandTarget(surfaceId)
				: undefined;
			setTarget(() => captured);
		}
	};
	const run = async (command: QuickCommand) => {
		if (!target || busy) return;
		setBusy(true);
		setError(undefined);
		try {
			await target(command);
		} catch (cause) {
			setError(
				t(
					cause instanceof QuickCommandInputError
						? cause.message
						: "workspace.quickCommands.unavailable",
				),
			);
		} finally {
			setBusy(false);
		}
	};
	const save = (command: QuickCommand) => {
		const state = useStore.getState();
		const current = state.uiPrefs.quickCommands ?? EMPTY_COMMANDS;
		state.setUiPrefs({
			quickCommands: current.some((item) => item.id === command.id)
				? current.map((item) => (item.id === command.id ? command : item))
				: [...current, command],
		});
		setEditor(null);
	};
	const remove = (id: string) => {
		const state = useStore.getState();
		state.setUiPrefs({
			quickCommands: (state.uiPrefs.quickCommands ?? EMPTY_COMMANDS).filter(
				(item) => item.id !== id,
			),
		});
	};
	const move = (id: string, direction: -1 | 1) => {
		const state = useStore.getState();
		const current = state.uiPrefs.quickCommands ?? EMPTY_COMMANDS;
		const next = moveQuickCommand(current, id, direction);
		if (next !== current) state.setUiPrefs({ quickCommands: next });
	};
	const section: PaneActionMenuSection = {
		id: "quick-commands",
		items: [
			{
				id: "quick-commands",
				label: t("workspace.quickCommands.menu"),
				icon: createElement(SquareTerminal, { className: "size-3.5" }),
				groups: [
					{
						id: "saved",
						items: commands.length
							? commands.map((command) => ({
									id: command.id,
									label: command.label,
									hint: command.appendEnter ? "↵" : undefined,
									disabled: !target || busy,
									deferUntilClosed: true,
									onSelect: () => {
										void run(command);
									},
								}))
							: [
									{
										id: "empty",
										label: t("workspace.quickCommands.empty"),
										disabled: true,
										onSelect: () => {},
									},
								],
					},
				],
				footer: {
					id: "edit",
					items: [
						{
							id: "add",
							label: t("workspace.quickCommands.add"),
							deferUntilClosed: true,
							onSelect: () => setEditor("new"),
						},
						{
							id: "manage",
							label: t("workspace.quickCommands.manage"),
							disabled: commands.length === 0,
							deferUntilClosed: true,
							onSelect: () => setEditor("manage"),
						},
					],
				},
			},
		],
	};
	return {
		commands,
		editor,
		setEditor,
		save,
		remove,
		move,
		captureTarget,
		section,
		error,
		// The failure otherwise clears only on the next quick command, and the
		// notice now sits on the pane corner over the scroll-to-latest button.
		dismissError: () => setError(undefined),
	};
}
