import type { FolderBrowserEntry } from "./ipc";

export type FolderBrowserStage =
	| { readonly kind: "loading"; readonly rootPath?: string }
	| {
			readonly kind: "failed";
			readonly message: string;
			readonly rootPath?: string;
	  }
	| {
			readonly kind: "ready";
			readonly rootPath: string;
			readonly path: string;
			readonly entries: readonly FolderBrowserEntry[];
	  };

export interface NewFolderDraft {
	readonly name: string;
	readonly busy: boolean;
	readonly error?: string;
}

export interface FolderBrowserModel {
	readonly hubId: string;
	readonly boxLabel: string;
	readonly hosts: readonly FolderBrowserHost[];
	readonly stage: FolderBrowserStage;
	readonly hostOpen: boolean;
	readonly create?: NewFolderDraft;
}

export interface FolderBrowserHost {
	readonly id: string;
	readonly label: string;
}

export interface FolderPathRow {
	readonly label: string;
	readonly path: string;
	readonly depth: number;
	readonly selected: boolean;
}

export function folderName(path: string): string {
	const trimmed = path.replace(/\/+$/, "");
	return trimmed.slice(trimmed.lastIndexOf("/") + 1) || "/";
}

export function displayPath(rootPath: string, path: string): string {
	if (path === rootPath) return "~";
	return path.startsWith(`${rootPath}/`)
		? `~${path.slice(rootPath.length)}`
		: path;
}

/** Build the expanded ancestor rows ending at the current folder. */
export function pathRows(rootPath: string, path: string): FolderPathRow[] {
	if (path !== rootPath && !path.startsWith(`${rootPath}/`)) {
		return [{ label: folderName(path), path, depth: 0, selected: true }];
	}
	const rows: FolderPathRow[] = [
		{ label: "~", path: rootPath, depth: 0, selected: path === rootPath },
	];
	let current = rootPath;
	for (const part of path.slice(rootPath.length).split("/").filter(Boolean)) {
		current = `${current}/${part}`;
		rows.push({
			label: part,
			path: current,
			depth: rows.length,
			selected: current === path,
		});
	}
	return rows;
}
