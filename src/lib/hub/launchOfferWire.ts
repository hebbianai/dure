/**
 * The offer's wire shape, mirroring `dure-hub-protocol::launch_offer`.
 *
 * Written out rather than generated for the same reason `HubGitStatusReply` is:
 * the Tauri command deserializes straight into the Rust type, so serde matches
 * by the declared name and these must stay snake_case.
 */

export interface LaunchTarget {
	id: string;
	space_label: string;
	folder_label: string;
	box_label: string;
	path_hint: string;
	startable: boolean;
	/** Absent on older local-only offers. */
	worktree_supported?: boolean;
	/** Only reported targets may use the laptop's installed flags. */
	provider_installation?: "reported" | "check_on_start";
}

export interface AgentKind {
	id: string;
	label: string;
	installed: boolean;
}
