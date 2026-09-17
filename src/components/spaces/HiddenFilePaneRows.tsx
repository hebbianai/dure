// Hidden rows restore an exact view; dragging a file remains document-open intent.
import { EyeOff } from "lucide-react";
import { FileGlyph } from "@/components/sidebar/FileGlyph";
import { withDesktopDockview } from "@/lib/workspace/dock";
import { pathParentName } from "@/lib/files/paths";
import { restoreHiddenFilePaneOn } from "@/lib/files/fileViewerPane";
import { useHiddenFilePanes } from "@/lib/workspace/pane/hiddenFilePanesStore";
import { encodeDureDragPayload } from "@/lib/platform/productDragPayload";

export function HiddenFilePaneRows({ desktopId }: { desktopId: string }) {
	const hidden = useHiddenFilePanes((state) => state.hidden);
	const rows = Object.entries(hidden).filter(
		([, record]) => record.desktopId === desktopId,
	);
	if (rows.length === 0) return null;
	return (
		<>
			{rows.map(([panelId, record]) => {
				const name =
					record.file.path.split("/").filter(Boolean).pop() ?? record.file.path;
				return (
					<div
						key={panelId}
						className="flex w-full min-w-0 items-center rounded-md transition-colors duration-150 ease-out hover:bg-glass-tint-hover"
						draggable
						onDragStart={(event) => {
							// Opening a document in another Space does not retire this view.
							event.dataTransfer.setData(
								"text/plain",
								encodeDureDragPayload({ type: "file", ...record.file, isDir: false }),
							);
							event.dataTransfer.effectAllowed = "copyMove";
						}}
					>
						<button
							type="button"
							// 좌우 12px — 같은 섹션의 세션 행(2386:41129)과 같은 열에
							// 선다. 8px이면 바로 위 행보다 4px 안쪽으로 밀려 보인다.
							className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-3 py-1.5 text-left opacity-60 focus-visible:outline-none focus-visible:inset-ring-1 focus-visible:inset-ring-ring"
							onClick={() =>
								withDesktopDockview(desktopId, (api) => {
									restoreHiddenFilePaneOn(api, panelId, record);
								})
							}
						>
							<EyeOff className="size-3 shrink-0 text-muted-foreground" />
							<FileGlyph />
							<span className="min-w-0 truncate text-xs font-normal text-sidebar-foreground">
								{name}
							</span>
							<span className="min-w-0 shrink-[2] truncate font-mono text-meta text-muted-foreground">
								{pathParentName(record.file.path)}
							</span>
						</button>
					</div>
				);
			})}
		</>
	);
}
