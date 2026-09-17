import { useEffect, useState } from "react";
import {
	type GitHubWorkspaceRequest,
	type GitHubWorkspaceSnapshot,
	loadGitHubWorkspace,
} from "@/lib/github/githubWorkspaceQuery";
import {
	ghRepository,
	ghWorkspaceProjects,
	ghWorkspaceWorkItems,
} from "@/lib/ipc/github";

const queries = {
	repository: ghRepository,
	projects: ghWorkspaceProjects,
	workItems: ghWorkspaceWorkItems,
};

export function useGitHubWorkspaceQuery(
	{ targets, view, preset, query }: GitHubWorkspaceRequest,
	signature: string,
	revealed: boolean,
) {
	const [result, setResult] = useState<{
		signature: string;
		payload: GitHubWorkspaceSnapshot;
	} | null>(null);
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		if (!revealed) return;
		const request = new AbortController();
		setBusy(true);
		void loadGitHubWorkspace(
			{ targets, view, preset, query },
			queries,
			request.signal,
		).then((payload) => {
			if (!payload || request.signal.aborted) return;
			setResult({ signature, payload });
			setBusy(false);
		});
		return () => request.abort();
	}, [targets, view, preset, query, signature, revealed]);
	return {
		payload: result?.signature === signature ? result.payload : null,
		busy,
	};
}
