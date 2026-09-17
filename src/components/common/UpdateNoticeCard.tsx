import { X } from "lucide-react";
import { FLOATING_CARD } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Disclosure } from "@/components/ui/disclosure";
import { IconButton } from "@/components/ui/icon-button";
import { t } from "@/lib/i18n";
import {
	performUpdateNoticeAction,
	type UpdateNoticeSnapshot,
} from "@/lib/updates/updateNotice";

/** The same source-owned action in transient notices and persistent settings. */
export function UpdateNoticeCard({
	notice,
	onDismiss,
}: {
	notice: UpdateNoticeSnapshot["notices"][number];
	onDismiss?: () => void;
}) {
	return (
		// The floating card's chrome (FLOATING_CARD): the menu material and
		// shadow on the pane radius, the same material the brief toasts wear.
		// It was shadcn's popover/border/shadow-lg/rounded-xl (owner request
		// 2026-09-10), then the opaque pane fill, and on 2026-09-13 the menu
		// material, since over a pane the opaque fill vanished. The filled
		// primary button stays, as in the dialogs' confirm. The close is the
		// family's IconButton.
		<section className={`pointer-events-auto p-4 text-foreground ${FLOATING_CARD}`}>
			<div className="flex items-start gap-3">
				<div className="min-w-0 flex-1">
					<h2 className="text-base font-semibold">{notice.title}</h2>
					<p className="mt-3 text-sm text-muted-foreground">
						{notice.description}
					</p>
					<p className="mt-2 text-xs text-muted-foreground">{notice.impact}</p>
				</div>
				{onDismiss ? (
					<IconButton
						title={t("common.close")}
						className="-my-1 -mr-1"
						disabled={notice.phase === "running"}
						onClick={onDismiss}
					>
						<X />
					</IconButton>
				) : null}
			</div>
			{notice.details ? (
				<Disclosure className="mt-3" label={t("common.details")}>
					<p className="max-h-32 overflow-auto whitespace-pre-wrap break-words text-muted-foreground">
						{notice.details}
					</p>
				</Disclosure>
			) : null}
			{notice.error ? (
				<p
					role="alert"
					className="mt-3 max-h-24 select-text overflow-auto break-words text-xs text-destructive"
				>
					{notice.error}
				</p>
			) : null}
			{notice.progress ? (
				<div className="mt-3 space-y-1.5">
					<p role="status" className="text-xs text-muted-foreground">{notice.progress.label}</p>
					{notice.progress.percent !== undefined ? (
						<progress
							aria-label={notice.progress.label}
							value={notice.progress.percent}
							max={100}
							className="h-1 w-full appearance-none overflow-hidden rounded-full bg-muted [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:bg-foreground [&::-moz-progress-bar]:bg-foreground"
						/>
					) : null}
				</div>
			) : null}
			<Button
				type="button"
				size="lg"
				className="mt-4 w-full"
				disabled={notice.phase === "running" || notice.primaryAction.disabled}
				onClick={() => void performUpdateNoticeAction(notice.sourceRef)}
			>
				{notice.phase === "running"
					? notice.primaryAction.progressLabel
					: notice.primaryAction.label}
			</Button>
		</section>
	);
}
