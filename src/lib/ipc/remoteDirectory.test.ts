import { beforeEach, expect, it, vi } from "vitest";
import type { SshHostConfig } from "@/types";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { listRemoteDir } from "./git";

const host: SshHostConfig = {
	id: "host",
	name: "host",
	host: "remote.test",
	user: "dev",
	port: 22,
	auth: "auto",
};
beforeEach(() => {
	invoke.mockReset();
});

it("preserves remote filenames and applies only the requested hidden-file filter", async () => {
	const entries = [".git", "한 글", "line\nbreak", "trailing "].map((name) => ({
		name,
		path: `/repo/${name}`,
		isDir: true,
		isRepo: false,
	}));
	invoke.mockResolvedValue({ path: "/repo", entries, isRepo: true });
	expect(await listRemoteDir(host, "/repo")).toEqual(entries.slice(1));
	expect(await listRemoteDir(host, "/repo", true)).toEqual(entries);
});

it("propagates a failed listing instead of returning an empty directory", async () => {
	invoke.mockRejectedValue(new Error("permission denied"));
	await expect(listRemoteDir(host, "/private")).rejects.toThrow(
		"permission denied",
	);
});
