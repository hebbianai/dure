import { beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
	invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
	invoke: tauri.invoke,
}));

import {
	mergeWorkspaceHardwareProfiles,
	readSystemHardwareProfile,
} from "@/lib/workspace/performance/workspaceHardwareProfile";

describe("workspace hardware profile", () => {
	beforeEach(() => {
		tauri.invoke.mockReset();
	});

	it("uses native logical cores instead of a privacy-capped browser hint", async () => {
		tauri.invoke.mockResolvedValue({
			logicalCores: 16,
			physicalMemoryBytes: 48 * 1024 ** 3,
		});

		const native = await readSystemHardwareProfile(true);

		expect(tauri.invoke).toHaveBeenCalledWith("system_hardware_profile");
		expect(
			mergeWorkspaceHardwareProfiles(
				{ logicalCores: 8, deviceMemoryGb: undefined },
				native,
			),
		).toEqual({
			logicalCores: 16,
			deviceMemoryGb: undefined,
			physicalMemoryBytes: 48 * 1024 ** 3,
		});
	});

	it("falls back to browser hints when the native adapter is unavailable", async () => {
		tauri.invoke.mockRejectedValue(new Error("browser harness"));

		const native = await readSystemHardwareProfile(true);

		expect(
			mergeWorkspaceHardwareProfiles(
				{ logicalCores: 8, deviceMemoryGb: 8 },
				native,
			),
		).toEqual({
			logicalCores: 8,
			deviceMemoryGb: 8,
			physicalMemoryBytes: undefined,
		});
	});

	it("rejects malformed native core and physical-memory values", async () => {
		tauri.invoke.mockResolvedValue({
			logicalCores: 0,
			physicalMemoryBytes: Number.POSITIVE_INFINITY,
		});

		expect(await readSystemHardwareProfile(true)).toEqual({
			logicalCores: undefined,
			physicalMemoryBytes: undefined,
		});
	});
});
