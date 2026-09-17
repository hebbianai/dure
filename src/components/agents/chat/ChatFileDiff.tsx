import type {
	FileDiffLine,
	FileEditDiff,
} from "@/lib/agents/chat/fileEditDiff";
import { t } from "@/lib/i18n";

type LineKind = FileDiffLine["kind"];

/** Row tone, matching the SCM split diff (`bg-vcs-added/12`): the same fact
 * must not look different in two places, and a tint carries it without
 * turning a transcript into a wall of color. */
function rowTone(kind: LineKind): string {
	switch (kind) {
		case "added":
			return "bg-vcs-added/12 text-foreground/85";
		case "removed":
			return "bg-vcs-deleted/12 text-foreground/85";
		default:
			return "text-muted-foreground";
	}
}

/** Marker column: the sign a diff reader scans for, and the one place the
 * VCS color itself appears. */
function marker(kind: LineKind): { text: string; tone: string } {
	switch (kind) {
		case "added":
			return { text: "+", tone: "text-vcs-added" };
		case "removed":
			return { text: "−", tone: "text-vcs-deleted" };
		default:
			return { text: " ", tone: "" };
	}
}

/** The lines one tool call changed in one file. Code sits on an opaque
 * surface (never glass), tinted per line rather than shouted in color, with
 * collapsed and dropped lines stated instead of silently missing. */
export function ChatFileDiff({
	diff,
	path,
}: {
	diff: FileEditDiff;
	/** Shown only when one row carries several files — otherwise the
	 * collapsed tool row already names the file. */
	path?: string | null;
}) {
	return (
		<div className="overflow-hidden rounded-md border border-border/60 bg-muted/30">
			{path && (
				<div className="truncate border-b border-border/60 px-2 py-1 font-mono text-[11px] text-muted-foreground">
					{path}
				</div>
			)}
			<div className="max-h-72 overflow-auto py-1 font-mono text-[11px] leading-[1.45]">
				{diff.lines.map((line, index) => {
					const quiet = line.kind === "hunk" || line.kind === "gap";
					const sign = marker(line.kind);
					return (
						<div
							// Diff rows have no identity of their own; position is the key.
							key={`${index}-${line.kind}`}
							className={`flex gap-1.5 px-2 ${
								quiet ? "text-muted-foreground/70" : rowTone(line.kind)
							}`}
						>
							<span
								aria-hidden="true"
								className={`shrink-0 select-none ${quiet ? "" : sign.tone}`}
							>
								{quiet ? " " : sign.text}
							</span>
							<span className="min-w-0 whitespace-pre-wrap">
								{line.kind === "gap"
									? t("agents.chat.diffUnchanged", { count: line.hiddenLines })
									: line.text}
							</span>
						</div>
					);
				})}
			</div>
			{diff.hiddenLines > 0 && (
				<div className="border-t border-border/60 px-2 py-1 text-[11px] text-muted-foreground">
					{t("agents.chat.diffTruncated", { count: diff.hiddenLines })}
				</div>
			)}
		</div>
	);
}
