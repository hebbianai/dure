/**
 * 셀프호스티드 러너 디스크 정리 판정 — 순수 모듈.
 *
 * 왜 별도 장치가 필요한가(2026-07-30 사고): 러너 머신이 가득 차면 job은 우리
 * 코드가 실행되기 전에 죽는다. 실제 실패는 "Set up job"에서 액션 tarball을 푸는
 * 중의 `No space left on device`였다 — 워크플로 안에 preflight 스텝을 넣어도
 * 그 스텝보다 먼저 일어나므로 막을 수 없다. 그래서 정리는 job 안이 아니라
 * **주기적으로 미리** 돌아야 한다.
 *
 * 왜 기존 캐시 관리로 부족한가: `manage-ci-cargo-target.sh`의 상한(기본
 * 12GiB)과 보존(14일)은 **프로파일 단위**이고, 그 프로파일을 쓰는 워크플로가
 * 다시 돌 때(`prepare`)만 적용된다. 프로파일이 5개면 러너 하나가 최대 60GiB를
 * 쥘 수 있고, 어떤 워크플로가 한동안 안 돌면 그 몫은 14일간 그대로 남는다.
 * 여기서는 루트 전체 예산으로 본다.
 *
 * 안전 규칙은 하나다: **쓰이고 있을 수 있는 것은 건드리지 않는다.** 예약
 * maintenance는 job 생명주기를 관측할 권위가 없으므로 `.lease`가 존재하는
 * 프로파일은 나이와 무관하게 건너뛴다. stale lease는 runner가 한 번에 job
 * 하나만 받는 경계에서 다음 `prepare`가 회수한다.
 */

import { storageReclaimNeed } from "./disk-space.mjs";

/** `manage-ci-cargo-target.sh`의 프로파일 허용 목록과 같아야 한다. 여기 없는
 *  이름은 워크플로가 사라졌다는 뜻이므로 고아로 본다. 새 프로파일을 추가할 때
 *  두 곳을 같이 고치지 않으면, 이 정리가 살아 있는 캐시를 고아로 오인한다. */
export const KNOWN_CI_TARGET_PROFILES = Object.freeze([
	"verify",
	"windows-cross-target",
	"linux-musl-artifacts",
	"hmux-release-trust",
	"hmux-release-promotion",
]);

export const RUNNER_DISK_POLICY = Object.freeze({
	/** 모든 비활성 Cargo target 프로파일을 합친 root-level 상한. */
	cacheBudgetBytes: 60 * 1024 ** 3,
	/** 이 아래면 정리한다. */
	floorBytes: 60 * 1024 ** 3,
	/** 정리 후 목표. */
	goalBytes: 200 * 1024 ** 3,
	/** 세대 보존. 같은 스크립트의 기본 보존(14일)과 맞춘다. */
	retentionSeconds: 14 * 24 * 3600,
	/** 저장소 작업 디렉터리·액션 캐시는 이만큼 조용해야 지운다.
	 *  실행 중인 job의 것을 지우면 그 job이 깨진다 — 넉넉히 잡는다. */
	idleSeconds: 24 * 3600,
});

export function runnerDiskNeed(
	{ availableBytes, totalCacheBytes },
	policy = RUNNER_DISK_POLICY,
) {
	const need = storageReclaimNeed({
		availBytes: availableBytes,
		cacheBudgetBytes: policy.cacheBudgetBytes,
		floorBytes: policy.floorBytes,
		goalBytes: policy.goalBytes,
		totalCacheBytes,
	});
	return {
		cacheExcessBytes: need.cacheExcessBytes,
		freeSpaceNeedBytes: need.freeSpaceNeedBytes,
		unknownSpace: need.unknown,
	};
}

export function runnerStorageSatisfied(
	{ availableBytes, totalCacheBytes },
	policy = RUNNER_DISK_POLICY,
) {
	return (
		Number.isFinite(availableBytes) &&
		availableBytes >= policy.floorBytes &&
		Number.isFinite(totalCacheBytes) &&
		totalCacheBytes >= 0 &&
		totalCacheBytes <= policy.cacheBudgetBytes
	);
}

function oldestFirst(left, right) {
	return (
		right.ageSeconds - left.ageSeconds ||
		right.bytes - left.bytes ||
		left.path.localeCompare(right.path)
	);
}

/** Meet the cache budget with Cargo LRU entries first, then satisfy any larger
 * physical free-space deficit from the remaining safe candidates. */
export function planRunnerReclaim(
	candidates,
	{ cacheExcessBytes = 0, freeSpaceNeedBytes = 0, all = false } = {},
) {
	const ordered = [...candidates].sort(oldestFirst);
	if (all) {
		const selected = ordered.filter(
			(entry) => entry.reason !== "root-budget-lru",
		);
		let freedBytes = selected.reduce((total, entry) => total + entry.bytes, 0);
		let cacheFreedBytes = selected
			.filter((entry) => entry.category === "cargo-target")
			.reduce((total, entry) => total + entry.bytes, 0);
		for (const entry of ordered) {
			if (
				cacheFreedBytes >= cacheExcessBytes &&
				freedBytes >= freeSpaceNeedBytes
			) {
				break;
			}
			if (entry.reason !== "root-budget-lru") continue;
			selected.push(entry);
			freedBytes += entry.bytes;
			cacheFreedBytes += entry.bytes;
		}
		return {
			selected,
			freedBytes,
			cacheFreedBytes,
			cacheSatisfied: cacheFreedBytes >= cacheExcessBytes,
			floorSatisfied: freedBytes >= freeSpaceNeedBytes,
		};
	}

	const selected = [];
	const selectedPaths = new Set();
	let freedBytes = 0;
	let cacheFreedBytes = 0;
	for (const entry of ordered) {
		if (entry.category !== "cargo-target") continue;
		if (cacheFreedBytes >= cacheExcessBytes) break;
		selected.push(entry);
		selectedPaths.add(entry.path);
		freedBytes += entry.bytes;
		cacheFreedBytes += entry.bytes;
	}
	for (const entry of ordered) {
		if (freedBytes >= freeSpaceNeedBytes) break;
		if (selectedPaths.has(entry.path)) continue;
		selected.push(entry);
		selectedPaths.add(entry.path);
		freedBytes += entry.bytes;
		if (entry.category === "cargo-target") cacheFreedBytes += entry.bytes;
	}
	return {
		selected,
		freedBytes,
		cacheFreedBytes,
		cacheSatisfied: cacheFreedBytes >= cacheExcessBytes,
		floorSatisfied: freedBytes >= freeSpaceNeedBytes,
	};
}

/**
 * 지우기 직전 방어선: 러너 work 루트 바로 아래(또는 그 하위)인가.
 *
 * 러너의 홈이나 시스템 경로가 계산 실수로 넘어오는 것을 막는다.
 */
export function isRunnerOwnedPath(runnerWork, path) {
	if (typeof runnerWork !== "string" || typeof path !== "string") return false;
	if (!runnerWork || !path) return false;
	const root = runnerWork.replace(/\/+$/, "");
	if (!path.startsWith(`${root}/`)) return false;
	const segments = path.slice(root.length + 1).split("/");
	if (segments.length === 0) return false;
	if (segments.some((segment) => segment === "" || segment === "..")) return false;
	return true;
}

/**
 * 카고 target 캐시 프로파일 하나에서 회수할 세대들.
 *
 * @param {{
 *   name: string,
 *   leased: boolean,
 *   generations: {path: string, bytes: number, ageSeconds: number}[],
 * }} profile
 * @param {object} policy
 * @returns {{skipped?: string, evict: object[]}}
 */
export function profileEviction(profile, policy = RUNNER_DISK_POLICY) {
	// Scheduled maintenance cannot prove that an old lease owner is dead. Only
	// the next serial runner job's prepare boundary may reconcile lease age.
	if (profile.leased) {
		return { skipped: "leased", evict: [] };
	}

	const known = KNOWN_CI_TARGET_PROFILES.includes(profile.name);
	if (!known) {
		// 워크플로가 사라진 프로파일 — 전량 회수한다.
		return { evict: [...profile.generations] };
	}

	const ordered = [...profile.generations].sort(
		(a, b) => a.ageSeconds - b.ageSeconds || a.path.localeCompare(b.path),
	);
	const evict = [];
	for (const [index, generation] of ordered.entries()) {
		// 가장 최신 세대 하나는 남긴다 — 다음 빌드의 증분 캐시다. 그것까지
		// 지우면 정리가 곧 전체 재빌드가 되어 러너를 더 오래 붙잡는다.
		if (index === 0) continue;
		if (generation.ageSeconds >= policy.retentionSeconds) {
			evict.push({ ...generation, reason: "expired" });
			continue;
		}
		evict.push({ ...generation, reason: "superseded" });
	}
	return { evict };
}

/**
 * 오래 조용한 러너 디렉터리(사라진 저장소의 작업 폴더, 액션·임시 캐시).
 *
 * 이름으로 "쓰는 저장소"를 맞히려 하지 않는다 — 저장소는 이름이 바뀌고(이
 * 저장소도 HebbianIDE → dure → dure-internal로 두 번 바뀌었다) 목록은 곧
 * 낡는다. 대신 "아무도 오래 건드리지 않았다"는 관측을 쓴다.
 */
export function staleEntries(entries, policy = RUNNER_DISK_POLICY) {
	return entries.filter((entry) => entry.ageSeconds >= policy.idleSeconds);
}

/** 사람이 읽는 한 줄 요약 — 로그가 곧 다음 사람의 진단 자료다. */
export function summarize(groups) {
	return Object.entries(groups)
		.filter(([, entries]) => entries.length > 0)
		.map(([name, entries]) => `${name} ${entries.length}`)
		.join(", ");
}
