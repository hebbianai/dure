import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";
import type { IDockviewPanelProps } from "dockview-react";
import { FolderOpen } from "lucide-react";
import { useMemo, useState } from "react";
import { WorktreeAgentDialog } from "@/components/agents/WorktreeAgentDialog";
import { Titled } from "@/components/ui/tooltip";
import {
	type RepositoryAddAgentDialogTarget,
	useRepositoryQuickAdd,
} from "@/components/spaces/useRepositoryQuickAdd";
import { Button } from "@/components/ui/button";
import { PaneLaunchChoices } from "@/components/workspace/PaneLaunchChoices";
import { usePaneLaunchState } from "@/components/workspace/usePaneLaunchState";
import {
	useWorkspaceDurableLayoutCommit,
	useWorkspaceRuntimeDesktopId,
} from "@/components/workspace/WorkspaceRuntimeContext";
import { pathBasename } from "@/lib/files/paths";
import { t } from "@/lib/i18n";
import { showErrorToast } from "@/lib/toast";
import { openAgentPanel } from "@/lib/workspace/dock";
import {
	openSplitTerminalPanel,
	paneSplitTargetForPanel,
} from "@/lib/workspace/pane/paneSplit";
import type { PaneSplitPaneParams } from "@/lib/workspace/pane/paneSplitTarget";
import type { Provider } from "@/types";

/** A durable layout placeholder, never a terminal session until the user chooses. */
export function PaneLauncher(props: IDockviewPanelProps<PaneSplitPaneParams>) {
	const desktopId = useWorkspaceRuntimeDesktopId();
	const commitLayout = useWorkspaceDurableLayoutCommit();
	const target = paneSplitTargetForPanel(props.api, props.params);
	const { rows, host } = usePaneLaunchState(
		target.kind === "ssh" ? target.hostId : undefined,
	);
	const position = useMemo(
		() => ({ replacement: props.api }),
		[props.api],
	);
	const [dialog, setDialog] = useState<RepositoryAddAgentDialogTarget | null>(
		null,
	);
	const quickAdd = useRepositoryQuickAdd(setDialog, position, props.api.id);
	const [opening, setOpening] = useState<"terminal" | Provider | null>(null);
	const chooseFolder = async () => {
		if (target.kind !== "local") return;
		const panel = props.containerApi.getPanel(props.api.id);
		if (!panel) return;
		try {
			const directory = await openFolderDialog({
				directory: true,
				multiple: false,
				defaultPath: target.cwd,
				title: t("common.chooseWorkingFolder"),
			});
			if (
				typeof directory === "string" &&
				directory &&
				props.containerApi.getPanel(props.api.id) === panel
			) {
				panel.api.updateParameters({ cwd: directory });
				commitLayout?.();
			}
		} catch (error) {
			showErrorToast(t("common.folderOpenFailed", { e: String(error) }), { paneId: props.api.id });
		}
	};
	const openOptions = (provider?: Provider) => {
		if (!desktopId || (target.kind === "ssh" && !host)) return;
		setDialog({
			desktopId,
			initialProvider: provider,
			initialPath: target.cwd,
			...(host ? { host: { id: host.id, name: host.name } } : {}),
		});
	};
	const openTerminal = async () => {
		if (!desktopId || opening) return;
		setOpening("terminal");
		try {
			await openSplitTerminalPanel(desktopId, target, position);
		} finally {
			setOpening(null);
		}
	};
	const openAgent = async (provider: Provider) => {
		if (!desktopId || opening || (target.kind === "ssh" && !host)) return;
		if (target.cwd) {
			setOpening(provider);
			try {
				await quickAdd.onAddRepositoryAgent(
					desktopId,
					{
						label: pathBasename(target.cwd),
						path: target.cwd,
						...(host ? { hostId: host.id } : {}),
					},
					provider,
				);
			} finally {
				setOpening(null);
			}
		} else openOptions(provider);
	};
	return (
		<div className="flex h-full min-h-0 flex-col bg-surface-pane p-3 text-muted-foreground">
			{target.kind === "local" ? (
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="max-w-full justify-start self-start px-0 font-normal"
					aria-label={t("common.location")}
					title={target.cwd ?? t("agents.location.chooseAnotherFolder")}
					onClick={() => void chooseFolder()}
					disabled={opening !== null}
				>
					<FolderOpen className="size-3.5" />
					<span className="truncate">
						{target.cwd ?? t("agents.location.chooseFolder")}
					</span>
				</Button>
			) : (
				(target.cwd || host) && (
					<Titled title={target.cwd}>
						<p className="shrink-0 truncate text-xs">
							{host ? `${host.name} · ` : ""}
							{target.cwd}
						</p>
					</Titled>
				)
			)}
			{target.kind === "ssh" && !host ? (
				<p role="alert" className="text-xs text-destructive">
					{t("workspace.launcher.hostUnavailable")}
				</p>
			) : (
				<PaneLaunchChoices
					rows={rows}
					opening={opening}
					onTerminal={openTerminal}
					onAgent={openAgent}
				/>
			)}
			<button
				type="button"
				className="mt-auto shrink-0 self-start rounded-md px-3 py-2 text-xs hover:bg-accent hover:text-foreground"
				onClick={() => openOptions()}
				disabled={opening !== null || (target.kind === "ssh" && !host)}
			>
				{t("spaces.repository.addWithOptions")}
			</button>
			{dialog && (
				<WorktreeAgentDialog
					{...dialog}
					onClose={() => setDialog(null)}
					onCreated={(agent) => {
						openAgentPanel(dialog.desktopId, agent, position);
					}}
				/>
			)}
		</div>
	);
}
