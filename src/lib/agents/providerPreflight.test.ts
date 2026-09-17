import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	providerExecutable,
	requireProjectProvider,
} from "@/lib/agents/providerPreflight";
import { providerPreflight } from "@/lib/ipc";
import type { Project } from "@/types";

vi.mock("@/lib/ipc", () => ({ providerPreflight: vi.fn() }));

const project: Project = {
	id: "project",
	name: "repo",
	kind: "local",
	path: "/repo",
	isRepo: false,
};

describe("provider launch preflight", () => {
	beforeEach(() => vi.mocked(providerPreflight).mockReset());

	it("requests executable resolution without running version diagnostics", async () => {
		vi.mocked(providerPreflight).mockResolvedValue({
			executable: true,
		} as Awaited<ReturnType<typeof providerPreflight>>);
		await requireProjectProvider(project, "codex", {
			terminalEnv: { NO_COLOR: null },
		});
		expect(providerPreflight).toHaveBeenCalledWith({
			provider: "codex",
			command: "codex",
			cwd: "/repo",
			terminalEnv: { NO_COLOR: null },
			includeVersion: false,
		});
	});

	it("requests version diagnostics when the caller needs credential isolation evidence", async () => {
		vi.mocked(providerPreflight).mockResolvedValue({
			executable: true,
		} as Awaited<ReturnType<typeof providerPreflight>>);
		await requireProjectProvider(project, "claude", { includeVersion: true });
		expect(providerPreflight).toHaveBeenCalledWith(
			expect.objectContaining({ includeVersion: true }),
		);
	});

	it.each(["codex", "claude"] as const)(
		"allows %s to launch when only version diagnostics fail",
		async (provider) => {
			const diagnostic = {
				ready: false,
				executable: true,
				status: "version_timeout" as const,
				message: "version timed out",
			};
			vi.mocked(providerPreflight).mockResolvedValueOnce(
				diagnostic as Awaited<ReturnType<typeof providerPreflight>>,
			);
			await expect(requireProjectProvider(project, provider)).resolves.toEqual(
				diagnostic,
			);
		},
	);

	it("still reports an unavailable executable", async () => {
		vi.mocked(providerPreflight).mockResolvedValueOnce({
			ready: false,
			executable: false,
			message: "command not found",
		} as Awaited<ReturnType<typeof providerPreflight>>);
		await expect(requireProjectProvider(project, "codex")).rejects.toThrow(
			"command not found",
		);
	});
});

describe("providerExecutable", () => {
	it("uses the exact executable from single- and multiword provider commands", () => {
		expect(providerExecutable("codex")).toBe("codex");
		expect(providerExecutable("goose")).toBe("goose");
		expect(providerExecutable("rovo-dev")).toBe("acli");
	});
});
