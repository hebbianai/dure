import { ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";
import { UpdateNoticeCard } from "@/components/common/UpdateNoticeCard";
import { IconButton } from "@/components/ui/icon-button";
import { t } from "@/lib/i18n";
import {
	dismissUpdateNotice,
	type UpdateNoticeSnapshot,
} from "@/lib/updates/updateNotice";

/** Browse pending decisions without treating navigation as dismissal. */
export function UpdateNoticeQueue({
	notices,
}: {
	notices: UpdateNoticeSnapshot["notices"];
}) {
	const [selection, setSelection] = useState<{
		source: string;
		head: string;
	}>();
	const pending = notices.filter((notice) => !notice.dismissed);
	const head = pending[0];
	if (!head) return null;
	const headIdentity = JSON.stringify([head.sourceRef, head.revision]);
	const selectedIndex =
		head.phase !== "running" && selection?.head === headIdentity
			? pending.findIndex((notice) => notice.sourceRef === selection.source)
			: 0;
	const index = Math.max(0, selectedIndex);
	const selected = pending[index];
	const choose = (direction: number) =>
		setSelection({
			source:
				pending[(index + direction + pending.length) % pending.length]
					.sourceRef,
			head: headIdentity,
		});
	return (
		<div>
			<UpdateNoticeCard
				notice={selected}
				onDismiss={() => dismissUpdateNotice(selected.sourceRef)}
			/>
			{pending.length > 1 ? (
				<nav
					aria-label={t("updates.queue.label")}
					className="pointer-events-auto mt-2 flex items-center justify-end gap-2 text-xs text-muted-foreground"
				>
					<IconButton
						title={t("updates.queue.previous")}
						disabled={head.phase === "running"}
						onClick={() => choose(-1)}
					>
						<ChevronLeft />
					</IconButton>
					<span>
						{t("updates.queue.position", {
							current: index + 1,
							total: pending.length,
						})}
					</span>
					<IconButton
						title={t("updates.queue.next")}
						disabled={head.phase === "running"}
						onClick={() => choose(1)}
					>
						<ChevronRight />
					</IconButton>
				</nav>
			) : null}
		</div>
	);
}
