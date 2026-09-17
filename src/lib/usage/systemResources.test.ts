import { describe, expect, it } from "vitest";

import {
	describeResources,
	formatBytes,
	formatDiskFree,
	formatPercent,
	type SystemResources,
} from "@/lib/usage/systemResources";

const base: SystemResources = {
	cpuPercent: 12.4,
	memoryUsedBytes: 4.5 * 1024 ** 3,
	memoryTotalBytes: 16 * 1024 ** 3,
	diskFreeBytes: 120 * 1024 ** 3,
	diskTotalBytes: 926 * 1024 ** 3,
};

describe("formatBytes", () => {
	it("1024 단위로 접고 10 이상은 정수로 둔다", () => {
		expect(formatBytes(0)).toBe("0B");
		expect(formatBytes(512)).toBe("512B");
		expect(formatBytes(1536)).toBe("1.5KB");
		expect(formatBytes(4.5 * 1024 ** 3)).toBe("4.5GB");
		expect(formatBytes(120 * 1024 ** 3)).toBe("120GB");
	});

	it("음수·NaN은 0으로 읽는다 — 표본이 비어도 위젯이 깨지지 않는다", () => {
		expect(formatBytes(-1)).toBe("0B");
		expect(formatBytes(Number.NaN)).toBe("0B");
	});
});

describe("formatPercent", () => {
	it("0~100으로 자른다", () => {
		expect(formatPercent(12.4)).toBe("12%");
		expect(formatPercent(101.2)).toBe("100%");
		expect(formatPercent(-3)).toBe("0%");
	});
});

describe("formatDiskFree", () => {
	it("볼륨을 못 찾았으면 아무것도 그리지 않는다", () => {
		expect(formatDiskFree({ ...base, diskFreeBytes: null })).toBeNull();
		expect(formatDiskFree({ ...base, diskFreeBytes: undefined })).toBeNull();
	});

	it("남은 용량을 보여 준다 — 쓴 양이 아니라", () => {
		expect(formatDiskFree(base)).toBe("120GB");
	});
});

describe("describeResources", () => {
	const labels = { cpu: "CPU", memory: "메모리", sessions: "세션", disk: "디스크" };

	it("요약이 줄인 값을 전부 편다", () => {
		expect(describeResources(base, 3, labels)).toBe(
			"CPU 12% · 메모리 4.5GB / 16GB · 세션 3 · 디스크 120GB / 926GB",
		);
	});

	it("디스크를 못 재면 그 항목만 빠진다", () => {
		expect(describeResources({ ...base, diskFreeBytes: null }, 0, labels)).toBe(
			"CPU 12% · 메모리 4.5GB / 16GB · 세션 0",
		);
	});
});
