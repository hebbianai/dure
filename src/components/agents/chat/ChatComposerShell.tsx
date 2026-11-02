import { ArrowUp } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/lib/i18n";
import { noteUserInput } from "@/lib/scheduling/interactionSignals";

type ChatComposerInputProps = Omit<
	ComponentProps<"textarea">,
	| "value"
	| "onChange"
	| "onKeyDown"
	| "rows"
	| "className"
	| "placeholder"
	| "aria-label"
> & {
	value: string;
	onValueChange(value: string): void;
};

/** The floating glass composer every agent chat shares: notices above the
 * box, optional rows inside it (queue, attachments), a single-line
 * auto-growing input and a control row with the primary action on the
 * right. Enter submits; Shift+Enter and IME composition insert a newline.
 * Callers own the draft, the submission and what each control does. */
export function ChatComposerShell({
	onSubmit,
	notices,
	header,
	input,
	controls,
	action,
}: {
	onSubmit(): void;
	notices?: ReactNode;
	header?: ReactNode;
	input: ChatComposerInputProps;
	controls?: ReactNode;
	action: ReactNode;
}) {
	const { value, onValueChange, ...textarea } = input;
	return (
		<form
			className="px-2 pt-0.5 pb-2 @2xl/chat:px-3 @2xl/chat:pb-3"
			onSubmit={(event) => {
				event.preventDefault();
				onSubmit();
			}}
		>
			<div className="mx-auto max-w-3xl">
				{notices}
				{/* glass/chrome is the input-on-glass material (the same fill
				    SEARCH_FIELD_SURFACE uses), not the app floor. bg-background
				    made this bar darker than the pane it floats on, which reads
				    as sunken — depth here is brightness, not shadow (SOUL §3.2)
				    — and the gap widened once the pane surface stopped sharing
				    the app floor's value. */}
				<div className="flex flex-col gap-0.5 rounded-xl border border-glass-hairline bg-glass-chrome px-2 py-1.5 shadow-card backdrop-blur-xl transition-shadow duration-150 focus-within:shadow-menu @2xl/chat:rounded-2xl @2xl/chat:px-2.5">
					{header}
					{/* The grid mirror owns intrinsic height without a geometry read;
					    the sentinel preserves an empty trailing line. */}
					<div className="grid min-w-0">
						<div
							aria-hidden="true"
							className="invisible col-start-1 row-start-1 max-h-40 min-h-7 overflow-x-hidden overflow-y-auto whitespace-pre-wrap break-words px-1 py-1 text-[length:inherit]"
						>
							{`${value}​`}
						</div>
						<Textarea
							rows={1}
							value={value}
							onChange={(event) => {
								noteUserInput();
								onValueChange(event.target.value);
							}}
							onKeyDown={(event) => {
								if (
									event.key === "Enter" &&
									!event.shiftKey &&
									!event.nativeEvent.isComposing
								) {
									event.preventDefault();
									onSubmit();
								}
							}}
							placeholder={t("agents.chat.composerPlaceholder")}
							aria-label={t("agents.chat.composerLabel")}
							className="col-start-1 row-start-1 h-full max-h-40 min-h-7 resize-none overflow-y-auto border-0 bg-transparent px-1 py-1 text-[length:inherit] shadow-none focus-visible:ring-0 dark:bg-transparent dark:disabled:bg-transparent"
							{...textarea}
						/>
					</div>
					{/* Wrap instead of truncating: in a narrow pane three pills
					    squeezed onto one line all cut mid-word ("Reasoning
					    effo…"), which read as broken UI (user report
					    2026-08-31). */}
					<div className="flex min-w-0 flex-wrap items-center gap-0.5">
						{controls}
						<div className="ml-auto shrink-0 pl-2">{action}</div>
					</div>
				</div>
			</div>
		</form>
	);
}

export function ChatComposerSendButton({ disabled }: { disabled: boolean }) {
	return (
		<Button
			type="submit"
			size="icon-sm"
			className="rounded-full"
			title={t("agents.chat.send")}
			disabled={disabled}
		>
			<ArrowUp aria-hidden="true" />
		</Button>
	);
}
