import { describe, expect, it } from "vitest";
import { sessionKindExecutionProfile } from "./sessionKindExecutionProfile";

describe("session kind execution profile", () => {
	it("projects local and remote host capabilities without caller runtime branches", () => {
		const local = sessionKindExecutionProfile("pty");
		expect(local.transport).toBe("local");
		expect(local.worktreePathDialect).toBe("native");
		expect(local.hostLabel("ignored")).toBe("local");
		expect(local.locationOverride()).toBeUndefined();

		const remote = sessionKindExecutionProfile("ssh");
		expect(remote.transport).toBe("ssh");
		expect(remote.worktreePathDialect).toBe("posix");
		expect(remote.hostLabel("buildbox")).toBe("buildbox");
		expect(remote.locationOverride("buildbox")).toEqual({
			kind: "ssh",
			target: "buildbox",
		});
	});
});
