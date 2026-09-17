#!/usr/bin/env node
/**
 * 셀프호스티드 러너 디스크 정리.
 *
 *   node scripts/runner-disk-maintenance.mjs              # 계획만 (기본 dry-run)
 *   node scripts/runner-disk-maintenance.mjs --apply
 *   node scripts/runner-disk-maintenance.mjs --apply --all # 목표치가 아니라 전량
 *   node scripts/runner-disk-maintenance.mjs --require-floor  # 부족하면 exit 1
 *
 * 판정은 `lib/runner-disk.mjs`(순수), 공간 계산은 `lib/disk-space.mjs`를 쓴다.
 * 사고 배경과 왜 job 안이 아니라 예약 실행인지는 그 헤더 참조.
 */

import { appendFileSync, existsSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { availableBytes, measureBytes } from "./lib/disk-reclaim.mjs";
import { formatBytes } from "./lib/disk-space.mjs";
import {
	isRunnerOwnedPath,
	planRunnerReclaim,
	profileEviction,
	RUNNER_DISK_POLICY,
	runnerDiskNeed,
	runnerStorageSatisfied,
	staleEntries,
	summarize,
} from "./lib/runner-disk.mjs";

const CI_TARGET_ROOT = "_hebbian-ci-targets-v1";
/** 러너가 자기 용도로 쓰는 디렉터리 — 저장소 작업 폴더와 구분해 분류만 한다. */
const RUNNER_INTERNAL = new Set(["_actions", "_temp"]);
/** 아예 후보로 올리지 않는다.
 *  `_tool`은 툴체인 캐시라 지워도 다음 job이 곧 다시 받는다(비용 대비 효과가
 *  나쁘다). `_PipelineMapping`은 러너 자신의 상태이고 크기도 없다. */
const NEVER_TOUCH = new Set(["_tool", "_PipelineMapping"]);

const apply = process.argv.includes("--apply");
const all = process.argv.includes("--all");
const requireFloor = process.argv.includes("--require-floor");

function flag(name, fallback) {
	const found = process.argv.find((argument) => argument.startsWith(`--${name}=`));
	if (!found) return fallback;
	const value = Number(found.slice(`--${name}=`.length));
	return Number.isFinite(value) && value > 0 ? value * 1024 ** 3 : fallback;
}

const policy = {
	...RUNNER_DISK_POLICY,
	floorBytes: flag("floor", RUNNER_DISK_POLICY.floorBytes),
	goalBytes: flag("goal", RUNNER_DISK_POLICY.goalBytes),
};

// 호출자가 명시한 root가 GitHub runner의 ambient 환경보다 우선한다. 테스트와
// 수동 운영에서 RUNNER_WORK를 격리 root로 줬는데 RUNNER_WORKSPACE가 이기면
// `--apply`가 실제 runner work를 건드릴 수 있다.
const configuredRunnerWork =
	process.env.RUNNER_WORK ||
	(process.env.RUNNER_WORKSPACE
		? `${process.env.RUNNER_WORKSPACE}/..`
		: defaultRunnerWork());
const runnerWork = configuredRunnerWork ? realpathSync.native(configuredRunnerWork) : null;

function defaultRunnerWork() {
	// GITHUB_WORKSPACE = <work>/<repo>/<repo>. 두 단계 올라가면 work 루트다.
	const workspace = process.env.GITHUB_WORKSPACE;
	if (!workspace) return null;
	return `${workspace}/../..`;
}

function ageSeconds(path, now) {
	try {
		return Math.max(0, Math.round(now - statSync(path).mtimeMs / 1000));
	} catch {
		return Number.POSITIVE_INFINITY;
	}
}

/**
 * 이 디렉터리 안에서 가장 최근에 손댄 시각까지의 나이.
 *
 * 최상위 디렉터리의 mtime만 보면 안 된다: 디렉터리의 mtime은 **직속 자식이
 * 바뀔 때만** 갱신되므로, 안에서 활발히 빌드 중인 저장소 체크아웃
 * (`_work/<repo>/<repo>/...`)이라도 `_work/<repo>`는 몇 주 전 그대로일 수 있다.
 * 그 값으로 판단하면 사용 중인 작업 폴더를 지운다 — 픽스처에서 실제로 그렇게
 * 됐다. 얕은 깊이만 훑어 "가장 최근" 값을 쓴다.
 */
function newestAgeSeconds(path, now, depth = 2) {
	let newest = ageSeconds(path, now);
	if (depth <= 0) return newest;
	for (const child of directories(path)) {
		newest = Math.min(newest, newestAgeSeconds(join(path, child), now, depth - 1));
	}
	return newest;
}

function directories(path) {
	try {
		return readdirSync(path, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
			.map((entry) => entry.name);
	} catch {
		return [];
	}
}

function collect(now) {
	const candidates = [];
	if (!runnerWork || !existsSync(runnerWork)) return candidates;

	// 1) 카고 target 캐시 — 프로파일별 lease를 존중하고 세대만 회수한다.
	const targetRoot = join(runnerWork, CI_TARGET_ROOT);
	for (const name of directories(targetRoot)) {
		const profilePath = join(targetRoot, name);
		const leasePath = join(profilePath, ".lease");
		const generations = directories(profilePath)
			.filter((child) => child !== ".lease")
			.map((child) => ({
				path: join(profilePath, child),
				ageSeconds: ageSeconds(join(profilePath, child), now),
				bytes: 0,
			}));
		const verdict = profileEviction(
			{
				name,
				leased: existsSync(leasePath),
				generations,
			},
			policy,
		);
		if (verdict.skipped) {
			console.log(`skip(${verdict.skipped}) ${CI_TARGET_ROOT}/${name}`);
			continue;
		}
		const immediateReasons = new Map(
			verdict.evict.map((generation) => [generation.path, generation.reason]),
		);
		for (const generation of generations) {
			candidates.push({
				...generation,
				category: "cargo-target",
				reason: immediateReasons.has(generation.path)
					? immediateReasons.get(generation.path) ?? "orphan-profile"
					: "root-budget-lru",
			});
		}
	}

	// 2) 사라진 저장소의 작업 폴더 + 러너 내부 캐시 — 오래 조용한 것만.
	const workEntries = [];
	for (const name of directories(runnerWork)) {
		if (name === CI_TARGET_ROOT) continue;
		if (NEVER_TOUCH.has(name)) continue;
		const path = join(runnerWork, name);
		workEntries.push({
			path,
			ageSeconds: newestAgeSeconds(path, now),
			bytes: 0,
			category: RUNNER_INTERNAL.has(name) ? "runner-cache" : "stale-repo",
		});
	}
	candidates.push(...staleEntries(workEntries, policy));

	return candidates;
}

const now = Date.now() / 1000;
const available = availableBytes(runnerWork ?? process.cwd());
const targetRoot = runnerWork ? join(runnerWork, CI_TARGET_ROOT) : null;
const totalCacheBefore = targetRoot && existsSync(targetRoot)
	? measureBytes([targetRoot])[0]?.bytes ?? 0
	: 0;
const need = runnerDiskNeed({
	availableBytes: available,
	totalCacheBytes: totalCacheBefore,
}, policy);

console.log(`runner work       ${runnerWork ?? "(unknown)"}`);
console.log(
	`여유 공간         ${formatBytes(available)}` +
		(need.unknownSpace ? " (측정 실패)" : "") +
		`  하한 ${formatBytes(policy.floorBytes)} / 목표 ${formatBytes(policy.goalBytes)}`,
);
console.log(
	`Cargo cache      ${formatBytes(totalCacheBefore)} / ${formatBytes(policy.cacheBudgetBytes)}`,
);

if (!runnerWork) {
	console.error(
		"runner work 루트를 찾지 못했습니다 (RUNNER_WORK/RUNNER_WORKSPACE/GITHUB_WORKSPACE 필요)",
	);
	process.exit(requireFloor ? 1 : 0);
}

const found = collect(now);
const measured = measureBytes(found.map((entry) => entry.path)).map((entry, index) => ({
	...found[index],
	...entry,
}));
const plan = planRunnerReclaim(measured, {
	all: all || need.unknownSpace,
	cacheExcessBytes: need.cacheExcessBytes,
	freeSpaceNeedBytes: need.freeSpaceNeedBytes,
});

console.log(
	`회수 후보         ${measured.length}개, ${formatBytes(
		measured.reduce((sum, entry) => sum + entry.bytes, 0),
	)}`,
);
const groups = {};
for (const entry of plan.selected) {
	groups[entry.category] = groups[entry.category] ?? [];
	groups[entry.category].push(entry);
}
if (plan.selected.length > 0) console.log(`회수 계획         ${summarize(groups)}`);

let removed = 0;
let freed = 0;
for (const entry of plan.selected) {
	const line = `${formatBytes(entry.bytes).padStart(10)}  ${entry.category}  ${entry.path}`;
	if (!apply) {
		console.log(`  회수 예정 ${line}`);
		continue;
	}
	// 마지막 방어선 — 계산 실수로 러너 밖 경로가 넘어오면 지우지 않는다.
	if (!isRunnerOwnedPath(runnerWork, entry.path)) {
		console.error(`  REFUSE    ${entry.path}`);
		continue;
	}
	try {
		rmSync(entry.path, { recursive: true, force: true });
		removed += 1;
		freed += entry.bytes;
		console.log(`  회수      ${line}`);
	} catch (error) {
		console.error(`  실패      ${entry.path}: ${error.message}`);
	}
}

const after = apply ? availableBytes(runnerWork) : available;
const totalCacheAfter = apply && targetRoot && existsSync(targetRoot)
	? measureBytes([targetRoot])[0]?.bytes ?? 0
	: totalCacheBefore;
if (apply) {
	console.log(`회수 완료         ${removed}개, ${formatBytes(freed)}`);
	console.log(`여유 공간         ${formatBytes(after)}`);
	console.log(
		`Cargo cache      ${formatBytes(totalCacheAfter)} / ${formatBytes(policy.cacheBudgetBytes)}`,
	);
}

if (
	requireFloor &&
	!runnerStorageSatisfied(
		{ availableBytes: after, totalCacheBytes: totalCacheAfter },
		policy,
	)
) {
	console.error(
		[
			"",
			"이 러너는 여전히 하한 아래이거나 cache budget을 초과했습니다.",
			`Free space ${formatBytes(after)} / floor ${formatBytes(policy.floorBytes)}; ` +
				`Cargo cache ${formatBytes(totalCacheAfter)} / budget ${formatBytes(policy.cacheBudgetBytes)}.`,
			"자동 회수로 닿지 않는 곳이 찼다는 뜻입니다 — 사람이 봐야 합니다.",
			"러너 홈의 캐시(~/Library/Caches, ~/Library/Developer, ~/.npm, ~/.rustup),",
			"다른 저장소의 작업 폴더, 또는 이 머신의 다른 용도를 확인하세요.",
		].join("\n"),
	);
	process.exit(1);
}

// GitHub Actions 요약에 남긴다 — 러너가 여러 대라 job 로그를 각각 열지 않고도
// 어느 머신이 어떻게 변했는지 한눈에 보이게 한다.
if (process.env.GITHUB_STEP_SUMMARY) {
	try {
		appendFileSync(
			process.env.GITHUB_STEP_SUMMARY,
			`- \`${hostname()}\`: ${formatBytes(available)} → ${formatBytes(after)} (회수 ${removed}개)\n`,
		);
	} catch {
		// 요약은 부가 정보다 — 실패해도 정리 결과를 뒤집지 않는다.
	}
}
