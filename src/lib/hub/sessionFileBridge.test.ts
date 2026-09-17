import { describe, expect, it, vi } from "vitest";
import { answerHubSessionFile } from "./sessionFileBridge";
import type { SessionLocation } from "./gitStatusBridge";

const request = {
	request_id: "file-1",
	session_id: "session-1",
	file: { fileName: "pasted-image.png", dataB64: "iVBORw==" },
};
describe("paired mobile session file staging", () => {
	it.each<SessionLocation>([
		{ kind: "local", worktreePath: "/work" },
		{ kind: "remote", boxId: "ssh-1", workspaceId: "workspace-1" },
	])("uses the existing file writer for $kind sessions", async (location) => {
		const deps = {
			locate: () => location,
			save: vi.fn(async () => ["/tmp/private/image.png"]),
			report: vi.fn(),
		};
		await answerHubSessionFile(request, deps);
		expect(deps.save).toHaveBeenCalledExactlyOnceWith(
			location.kind === "remote" ? "ssh-1" : undefined,
			[request.file],
		);
		expect(deps.report).toHaveBeenCalledExactlyOnceWith("file-1", {
			kind: "saved",
			path: "/tmp/private/image.png",
		});
	});
	it("refuses an unknown session without writing files", async () => {
		const deps = { locate: () => undefined, save: vi.fn(), report: vi.fn() };
		await answerHubSessionFile(request, deps);
		expect(deps.save).not.toHaveBeenCalled();
		expect(deps.report.mock.calls[0][1].kind).toBe("refused");
	});
	it("does not return a path after the session location changes during an upload", async () => {
		let location: SessionLocation = {
			kind: "remote",
			boxId: "before",
			workspaceId: "workspace",
		};
		const deps = {
			locate: () => location,
			report: vi.fn(),
			save: vi.fn(async () => {
				location = { kind: "remote", boxId: "after", workspaceId: "workspace" };
				return ["/tmp/old-machine/image.png"];
			}),
		};
		await answerHubSessionFile(request, deps);
		expect(deps.report.mock.calls[0][1].kind).toBe("refused");
	});
	it("refuses transfer failure without reporting an invented path", async () => {
		const deps = {
			locate: () =>
				({ kind: "local", worktreePath: "/work" }) as SessionLocation,
			save: vi.fn(async () => {
				throw new Error("disk full");
			}),
			report: vi.fn(),
		};
		await answerHubSessionFile(request, deps);
		expect(deps.report).toHaveBeenCalledExactlyOnceWith("file-1", {
			kind: "refused",
			detail: "disk full",
		});
	});
});
