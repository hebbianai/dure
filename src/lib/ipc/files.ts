// ipc/files — 파일 뷰어 읽기/쓰기.
//
// ipc.ts 도메인 분할 1단계(2026-08-01): 내용은 구 src/lib/ipc.ts에서 그대로
// 옮겨졌고, 소비자는 barrel(src/lib/ipc.ts)을 통해 기존 경로를 유지한다.
// invoke 래퍼는 이 디렉토리에만 둔다(architecture fitness 게이트가 강제).

import { invoke } from "@tauri-apps/api/core";
import type { SshConnectOpts } from "./sessions";

// ---------- file viewer ----------

export interface FileContent {
	name: string;
	path: string;
	kind: "text" | "markdown" | "image" | "pdf" | "video" | "binary";
	content: string; // text: utf8, 그 외: base64
	size: number;
	mime?: string;
	truncated: boolean;
}

export const readFile = (path: string) =>
	invoke<FileContent>("read_file", { path });

export const searchLocalDirectories = (query: string) =>
	invoke<string[]>("search_local_directories", { query });

export const inspectLocalDirectory = (path: string) =>
	invoke<string>("inspect_local_directory", { path });

export const sshReadFile = (opts: {
	id?: string;
	connectOpts?: SshConnectOpts;
	path: string;
}) =>
	invoke<FileContent>("ssh_read_file", {
		id: opts.id ?? null,
		opts: opts.connectOpts ?? null,
		path: opts.path,
	});

/**
 * 열려던 경로가 없을 때 저장소에서 같은 이름의 파일을 찾는다.
 * 에이전트가 디렉토리 없이 이름만 말한 경우("TerminalView.tsx")의 폴백.
 */
export const findFileCandidates = (path: string, limit?: number) =>
	invoke<string[]>("find_file_candidates", { path, limit: limit ?? null });

export const sshFindFileCandidates = (opts: {
	id?: string;
	connectOpts?: SshConnectOpts;
	path: string;
	limit?: number;
}) =>
	invoke<string[]>("ssh_find_file_candidates", {
		id: opts.id ?? null,
		opts: opts.connectOpts ?? null,
		path: opts.path,
		limit: opts.limit ?? null,
	});

/** 저장된 바이트 수를 반환. */
export const writeFile = (path: string, content: string) =>
	invoke<number>("write_file", { path, content });

export const sshWriteFile = (opts: {
	id?: string;
	connectOpts?: SshConnectOpts;
	path: string;
	content: string;
}) =>
	invoke<number>("ssh_write_file", {
		id: opts.id ?? null,
		opts: opts.connectOpts ?? null,
		path: opts.path,
		content: opts.content,
	});

/** SSH Files의 workspace root 아래 정확한 항목을 영구 삭제한다. */
export const sshDeleteFile = (opts: {
	connectOpts: SshConnectOpts;
	root: string;
	path: string;
	isDirectory: boolean;
}) =>
	invoke<void>("ssh_delete_file", {
		opts: opts.connectOpts,
		root: opts.root,
		path: opts.path,
		isDirectory: opts.isDirectory,
	});
