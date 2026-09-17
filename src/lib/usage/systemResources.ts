// 상태 표시줄 자원 위젯의 표시 규칙 — 순수 모듈.
//
// 상태 표시줄은 곁눈으로 읽는 자리라 자릿수를 줄이는 쪽이 정확도보다 낫다:
// "12%", "4.2GB", "세션 3"처럼 한 눈에 들어오는 길이로 자른다.

export interface SystemResources {
	cpuPercent: number;
	memoryUsedBytes: number;
	memoryTotalBytes: number;
	diskFreeBytes?: number | null;
	diskTotalBytes?: number | null;
}

const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

/** 1024 단위로 접고 소수는 한 자리까지 — 10 이상이면 정수로 둔다. */
export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return "0B";
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < UNITS.length - 1) {
		value /= 1024;
		unit += 1;
	}
	const rounded = value >= 10 || unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
	return `${rounded}${UNITS[unit]}`;
}

/** 0~100으로 자른 정수 퍼센트. 표본이 잠깐 넘쳐도 101%를 보이지 않는다. */
export function formatPercent(percent: number): string {
	if (!Number.isFinite(percent)) return "0%";
	return `${Math.round(Math.min(100, Math.max(0, percent)))}%`;
}

/** 메모리 요약 — 쓴 양만 보이고 전체는 title에 남긴다(자리 절약). */
export function formatMemory(resources: SystemResources): string {
	return formatBytes(resources.memoryUsedBytes);
}

/** 디스크는 "남은 용량"이다 — 상태 표시줄에서 궁금한 쪽은 쓴 양이 아니라
 *  얼마나 더 쓸 수 있는가다. 볼륨을 못 찾았으면 아무것도 그리지 않는다. */
export function formatDiskFree(resources: SystemResources): string | null {
	const free = resources.diskFreeBytes;
	if (free === undefined || free === null) return null;
	return formatBytes(free);
}

/** 위젯 title(호버) 한 줄 — 요약이 줄인 정보를 여기서 전부 말한다. */
export function describeResources(
	resources: SystemResources,
	sessions: number,
	labels: {
		cpu: string;
		memory: string;
		sessions: string;
		disk: string;
	},
): string {
	const parts = [
		`${labels.cpu} ${formatPercent(resources.cpuPercent)}`,
		`${labels.memory} ${formatBytes(resources.memoryUsedBytes)} / ${formatBytes(
			resources.memoryTotalBytes,
		)}`,
		`${labels.sessions} ${sessions}`,
	];
	const free = formatDiskFree(resources);
	if (free !== null && resources.diskTotalBytes) {
		parts.push(`${labels.disk} ${free} / ${formatBytes(resources.diskTotalBytes)}`);
	}
	return parts.join(" · ");
}
