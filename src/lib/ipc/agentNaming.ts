import { invoke } from "@tauri-apps/api/core";

/** Bounded one-shot headless naming call; rejects on unsupported provider/timeout. */
export const agentNameSuggestion = (
	providerId: string,
	prompt: string,
	cwd: string,
) => invoke<string>("agent_name_suggestion", { providerId, prompt, cwd });
