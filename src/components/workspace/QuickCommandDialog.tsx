import { ArrowDown, ArrowUp } from "lucide-react";
import { useId, useState } from "react";
import { DialogActionFooter } from "@/components/common/DialogActionFooter";
import { FormField } from "@/components/common/FormField";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { InlineConfirmRow } from "@/components/ui/inline-confirm";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/lib/i18n";
import {
	isQuickCommandComplete,
	QUICK_COMMAND_LABEL_LIMIT,
	type QuickCommand,
} from "@/lib/workspace/pane/quickCommands";

export function QuickCommandDialog({
	editor,
	commands,
	onEditorChange,
	onSave,
	onRemove,
	onMove,
}: {
	editor: QuickCommand | "new" | "manage";
	commands: QuickCommand[];
	onEditorChange: (editor: QuickCommand | "new" | "manage" | null) => void;
	onSave: (command: QuickCommand) => void;
	onRemove: (id: string) => void;
	onMove: (id: string, direction: -1 | 1) => void;
}) {
	const [draft, setDraft] = useState<QuickCommand>(() =>
		typeof editor === "object"
			? { ...editor }
			: {
					id: crypto.randomUUID(),
					label: "",
					text: "",
					appendEnter: false,
				},
	);
	const [removing, setRemoving] = useState<string>();
	const enterId = useId();
	const managing = editor === "manage";
	const save = () => {
		if (isQuickCommandComplete(draft))
			onSave({ ...draft, label: draft.label.trim() });
	};
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onEditorChange(null);
			}}
		>
			<DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
				<DialogHeader>
					<DialogTitle>
						{t(
							managing
								? "workspace.quickCommands.manage"
								: editor === "new"
									? "workspace.quickCommands.add"
									: "workspace.quickCommands.edit",
						)}
					</DialogTitle>
					<DialogDescription>
						{t("workspace.quickCommands.description")}
					</DialogDescription>
				</DialogHeader>
				{managing ? (
					<div className="grid gap-2">
						{commands.length === 0 && (
							<p className="text-xs text-muted-foreground">
								{t("workspace.quickCommands.empty")}
							</p>
						)}
						<ol>
							{commands.map((command, index) => (
								<li
									key={command.id}
									className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-2 border-b border-border py-2 sm:grid-cols-[auto_minmax(0,1fr)_auto]"
								>
									<div className="flex shrink-0 gap-0.5">
										{([-1, 1] as const).map((direction) => {
											const atBoundary =
												direction === -1
													? index === 0
													: index === commands.length - 1;
											const Icon = direction === -1 ? ArrowUp : ArrowDown;
											return (
												<IconButton
													key={direction}
													title={t(
														direction === -1
															? "workspace.quickCommands.moveUp"
															: "workspace.quickCommands.moveDown",
														{ label: command.label },
													)}
													aria-disabled={atBoundary}
													className="aria-disabled:opacity-40 aria-disabled:hover:bg-transparent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
													onClick={() => {
														if (!atBoundary) onMove(command.id, direction);
													}}
												>
													<Icon />
												</IconButton>
											);
										})}
									</div>
									<span className="min-w-0 wrap-anywhere text-xs">
										{command.label}
									</span>
									<div className="col-span-2 flex min-w-0 flex-wrap items-center justify-end gap-2 sm:col-span-1">
										{removing === command.id ? (
											<InlineConfirmRow
												question={t("workspace.quickCommands.removeConfirm")}
												onCancel={() => setRemoving(undefined)}
												onConfirm={() => {
													onRemove(command.id);
													setRemoving(undefined);
												}}
												confirmLabel={t("common.remove")}
											/>
										) : (
											<>
												<Button
													size="sm"
													variant="ghost"
													onClick={() => onEditorChange(command)}
												>
													{t("workspace.quickCommands.edit")}
												</Button>
												<Button
													size="sm"
													variant="ghost"
													onClick={() => setRemoving(command.id)}
												>
													{t("common.remove")}
												</Button>
											</>
										)}
									</div>
								</li>
							))}
						</ol>
						<Button variant="outline" onClick={() => onEditorChange("new")}>
							{t("workspace.quickCommands.add")}
						</Button>
					</div>
				) : (
					<>
						<div
							className="grid gap-4"
							onKeyDown={(event) => {
								if (
									(event.metaKey || event.ctrlKey) &&
									event.key === "Enter" &&
									!event.nativeEvent.isComposing
								) {
									event.preventDefault();
									save();
								}
							}}
						>
							<FormField label={t("workspace.quickCommands.label")}>
								<Input
									value={draft.label}
									maxLength={QUICK_COMMAND_LABEL_LIMIT}
									onChange={(event) =>
										setDraft({ ...draft, label: event.target.value })
									}
								/>
							</FormField>
							<FormField
								label={t("workspace.quickCommands.text")}
								description={t("workspace.quickCommands.textHelp")}
								error={
									draft.text.length > 0 &&
									!isQuickCommandComplete({ label: "valid", text: draft.text })
										? t("workspace.quickCommands.invalidText")
										: undefined
								}
							>
								<Textarea
									value={draft.text}
									className="min-h-40 max-h-[40dvh] resize-y font-mono text-xs"
									onChange={(event) =>
										setDraft({ ...draft, text: event.target.value })
									}
								/>
							</FormField>
							<div className="flex items-start gap-2">
								<Switch
									id={enterId}
									checked={draft.appendEnter}
									onCheckedChange={(appendEnter) =>
										setDraft({ ...draft, appendEnter })
									}
								/>
								<Label htmlFor={enterId} className="leading-5">
									{t("workspace.quickCommands.appendEnter")}
								</Label>
							</div>
						</div>
						<DialogActionFooter
							onCancel={() => onEditorChange(null)}
							confirmLabel={t("common.save")}
							onConfirm={save}
							disabled={!isQuickCommandComplete(draft)}
						/>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}
