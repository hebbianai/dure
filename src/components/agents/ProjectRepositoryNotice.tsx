import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import type { ProjectRepositoryState } from "./useProjectRepository";

export function ProjectRepositoryNotice({
	state,
	recheck,
}: {
	state: ProjectRepositoryState | null;
	recheck: () => void;
}) {
	if (!state || state.status === "repository") return null;
	return (
		<div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
			<p role="status">
				{t(
					state.status === "checking"
						? "agents.worktree.repositoryChecking"
						: state.status === "not_repository"
							? "agents.worktree.notGitRepo"
							: "agents.worktree.repositoryUnknown",
				)}
			</p>
			{state.status !== "checking" && (
				<Button variant="ghost" size="sm" onClick={recheck}>
					{t("panels.git.availability.recheck")}
				</Button>
			)}
		</div>
	);
}
