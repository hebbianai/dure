/**
 * 로컬 프로젝트 추가의 부수효과를 store 밖으로 뺀 슬라이스
 * (store.ts god-file 다이어트, hebbian-frontend-onzg 배선).
 */

import { nanoid } from "nanoid";
import { pathBasename } from "@/lib/files/paths";
import {
	codexTrustWorkspace,
	gitExecLocal,
	gitStatus,
	inspectLocalDirectory,
} from "@/lib/ipc";
import { repositoryDisplayName } from "@/lib/spaces/repositoryDisplayName";
import type { Project } from "@/types";

export interface LocalProjectIdentity {
	readonly path: string;
	readonly name: string;
}

/** 경로의 마지막 이름을 프로젝트 표시 이름으로. */
export function projectNameForPath(path: string): string {
	return pathBasename(path);
}

export function projectAtPath(
	projects: readonly Project[],
	path: string,
	sshHostId?: string,
): Project | undefined {
	const normalized = path.replace(/\/+$/, "") || path;
	return projects.find(
		(project) =>
			(project.path.replace(/\/+$/, "") || project.path) === normalized &&
			(sshHostId
				? project.kind === "ssh" && project.sshHostId === sshHostId
				: project.kind === "local"),
	);
}

/** Decide identity once against the latest stored list, not a window cache.
 * Preserve chosen names and positive repository observations. */
export function planProjectRegistration(
	projects: Project[],
	candidate: Project,
) {
	const existing = projectAtPath(projects, candidate.path, candidate.sshHostId);
	if (!existing)
		return { projects: [...projects, candidate], project: candidate };
	if (existing.kind !== "local" || existing.isRepo || !candidate.isRepo) {
		return { projects, project: existing };
	}
	const project = { ...existing, isRepo: true };
	return {
		projects: projects.map((item) =>
			item.id === existing.id ? project : item,
		),
		project,
	};
}

/** `git worktree list --porcelain -z`는 primary worktree를 첫 record로 준다. */
function primaryWorktreePath(output: string): string | undefined {
	const firstField = output.split("\0", 1)[0];
	if (!firstField?.startsWith("worktree ")) return undefined;
	return firstField.slice("worktree ".length) || undefined;
}

/** Project는 checkout이 아니라 repository를 나타낸다. linked worktree에서
 * 시작해도 Git이 선언한 primary worktree를 canonical Project 경로로 쓴다. */
async function canonicalLocalProjectPath(path: string): Promise<string> {
	const result = await gitExecLocal(path, [
		"worktree",
		"list",
		"--porcelain",
		"-z",
	]).catch(() => undefined);
	if (result?.code !== 0) return path;
	return primaryWorktreePath(result.stdout) ?? path;
}

async function localRepositoryDisplayName(path: string): Promise<string> {
	const result = await gitExecLocal(path, [
		"remote",
		"get-url",
		"origin",
	]).catch(() => undefined);
	return repositoryDisplayName(
		path,
		result?.code === 0 ? result.stdout : undefined,
	);
}

/** Canonical checkout and display name observed from the same repository. */
export async function inspectLocalProjectIdentity(
	path: string,
): Promise<LocalProjectIdentity> {
	const canonicalPath = await canonicalLocalProjectPath(path);
	return {
		path: canonicalPath,
		name: await localRepositoryDisplayName(canonicalPath),
	};
}

/** Inspect a local folder without admitting it into persistent project state. */
export async function inspectLocalProject(path: string): Promise<Project> {
	const directory = await inspectLocalDirectory(path);
	const identity = await inspectLocalProjectIdentity(directory);
	// Directory admission is authoritative; Git only enriches the project.
	const status = await gitStatus(identity.path).catch(() => ({ isRepo: false }));
	return {
		id: `proj-${nanoid(8)}`,
		name: status.isRepo ? identity.name : projectNameForPath(identity.path),
		path: identity.path,
		kind: "local",
		isRepo: status.isRepo,
	};
}

/**
 * Create a local project for a folder the user explicitly selected.
 *
 * Trusting the folder prevents the first Codex session from consuming input in
 * its trust modal. Trust remains best-effort because a failed trust write must
 * not make an otherwise usable folder impossible to open.
 */
export async function createLocalProject(path: string): Promise<Project> {
	const project = await inspectLocalProject(path);
	await codexTrustWorkspace(project.path).catch(() => false);
	return project;
}
