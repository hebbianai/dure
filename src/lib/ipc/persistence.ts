// ipc/persistence — 앱 control directory의 검토된 persistence 표면.

import { invoke } from "@tauri-apps/api/core";

/** CLI 호환 Agent registry의 이전 발행본. 파일명은 호출자가 정하지 않는다. */
export const readPublishedAgentRegistry = () =>
	invoke<string>("hebbian_read", { name: "agents.json" });

export const readWorktreePresentation = () =>
	invoke<{ imported: boolean; envelope: string }>("read_worktree_presentation");

export const completeWorktreePresentation = () =>
	invoke<void>("complete_worktree_presentation");
