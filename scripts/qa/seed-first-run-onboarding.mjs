#!/usr/bin/env node

import {
	chmodSync,
	existsSync,
	mkdirSync,
	realpathSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const ROOT_PREFIXES = [
	"/tmp/dure-onboarding-",
	"/private/tmp/dure-onboarding-",
	`${realpathSync(tmpdir())}/dure-onboarding-`,
];
const DAY_SECONDS = 24 * 60 * 60;

function requiredRoot(arguments_) {
	const index = arguments_.indexOf("--root");
	if (index < 0 || !arguments_[index + 1]) {
		throw new Error("usage: seed-first-run-onboarding.mjs --root <isolated-root>");
	}
	const requested = resolve(arguments_[index + 1]);
	if (!existsSync(requested)) throw new Error(`isolated root does not exist: ${requested}`);
	const root = realpathSync(requested);
	if (!ROOT_PREFIXES.some((prefix) => root.startsWith(prefix))) {
		throw new Error(`refusing non-onboarding temporary root: ${root}`);
	}
	return root;
}

function directory(path) {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	chmodSync(path, 0o700);
	return path;
}

function file(path, content, ageDays) {
	writeFileSync(path, `${content}\n`, { encoding: "utf8", mode: 0o600 });
	const modified = new Date(Date.now() - ageDays * DAY_SECONDS * 1000);
	utimesSync(path, modified, modified);
	return path;
}

function gitDirectory(repository, origin) {
	const git = directory(join(repository, ".git"));
	file(
		join(git, "config"),
		`[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${origin}`,
		0,
	);
	return git;
}

function claudeRecord(home, project, id, cwd, title, ageDays) {
	const directoryPath = directory(join(home, ".claude", "projects", project));
	return file(
		join(directoryPath, `${id}.jsonl`),
		JSON.stringify({
			type: "user",
			uuid: `message-${id}`,
			cwd,
			message: { content: title },
		}),
		ageDays,
	);
}

function codexRecord(home, id, cwd, title, ageDays, index) {
	const directoryPath = directory(
		join(home, ".codex", "sessions", "2026", "07", "31"),
	);
	return file(
		join(directoryPath, `rollout-${index}-${id}.jsonl`),
		[
			JSON.stringify({
				type: "session_meta",
				payload: { id, cwd },
			}),
			JSON.stringify({
				type: "response_item",
				payload: {
					type: "message",
					role: "user",
					content: title,
				},
			}),
		].join("\n"),
		ageDays,
	);
}

const root = requiredRoot(process.argv.slice(2));
const home = directory(join(root, "home"));
const repositories = directory(join(root, "fixtures", "repositories"));
const primary = directory(join(repositories, "HebbianIDE"));
const primaryGit = gitDirectory(primary, "https://github.com/hebbian/dure.git");
const linked = directory(join(repositories, "komojini-1"));
const linkedGit = directory(join(primaryGit, "worktrees", "komojini-1"));
file(join(linkedGit, "commondir"), "../..", 0);
file(join(linked, ".git"), `gitdir: ${linkedGit}`, 0);

// Same remote, distinct common-dir: the planner groups this checkout with the
// primary repository while retaining the exact cwd on its proposed pane.
const separateClone = directory(join(repositories, "HebbianIDE-copy"));
gitDirectory(separateClone, "git@github.com:hebbian/dure.git");

const standalone = directory(join(repositories, "standalone-notes"));
const records = [
	claudeRecord(
		home,
		"dure",
		"claude-recent-onboarding",
		primary,
		"온보딩 desktop 초안 다듬기",
		1,
	),
	codexRecord(
		home,
		"codex-linked-review",
		linked,
		"linked worktree 세션을 같은 desktop에 배치",
		2,
		1,
	),
	codexRecord(
		home,
		"codex-older-unchecked",
		primary,
		"오래된 세션은 기본 선택하지 않기",
		10,
		2,
	),
	claudeRecord(
		home,
		"dure",
		"claude-hidden-over-thirty-days",
		primary,
		"30일을 넘긴 세션은 숨기기",
		31,
	),
	codexRecord(
		home,
		"codex-separate-clone",
		separateClone,
		"같은 repository의 별도 checkout도 함께 배치",
		3,
		3,
	),
	codexRecord(
		home,
		"codex-standalone-folder",
		standalone,
		"Git 밖의 폴더도 독립 desktop으로 제안",
		6,
		4,
	),
];

process.stdout.write(
	`${JSON.stringify(
		{
			schemaVersion: 1,
			root,
			home,
			recordCount: records.length,
			expectedVisibleCount: 5,
			expectedDefaultSelectedCount: 4,
			expectedDesktopCount: 2,
			repositories: { primary, linked, separateClone, standalone },
		},
		null,
		2,
	)}\n`,
);
