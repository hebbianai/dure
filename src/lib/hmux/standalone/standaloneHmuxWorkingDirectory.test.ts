import { describe, expect, it } from "vitest";
import { projectAttachedStandaloneHmuxWorkingDirectory } from "@/lib/hmux/standalone/standaloneHmuxWorkingDirectory";
import { projectStandaloneHmuxAttachParams } from "@/lib/hmux/standalone/standaloneHmuxPaneSetProjection";
import { hmuxStandaloneBinding } from "@/lib/terminal/terminalBinding";

const source = hmuxStandaloneBinding("standalone-source", "workspace-source");
const target = hmuxStandaloneBinding("standalone-target", "workspace-target");

describe("standalone Hmux working-directory projection", () => {
	it("installs the Host cwd only on its exact attached pane", () => {
		const current = {
			sessionId: target.sessionId,
			binding: target,
			cwd: "/old",
		};

		expect(
			projectAttachedStandaloneHmuxWorkingDirectory(
				current,
				target,
				"/repo/worktree",
			),
		).toEqual({ ...current, cwd: "/repo/worktree" });
		expect(
			projectAttachedStandaloneHmuxWorkingDirectory(
				current,
				source,
				"/wrong-session",
			),
		).toBeUndefined();
	});

	it("drops a source cwd when an attach changes session without a target cwd", () => {
		expect(
			projectStandaloneHmuxAttachParams(
				{
					sessionId: source.sessionId,
					binding: source,
					cwd: "/source/repo",
				},
				target,
			),
		).toEqual({
			sessionId: target.sessionId,
			binding: target,
		});
	});

	it("preserves a known cwd when an attach keeps the exact session", () => {
		const current = {
			sessionId: target.sessionId,
			binding: target,
			cwd: "/repo/worktree",
		};
		expect(projectStandaloneHmuxAttachParams(current, target)).toEqual(current);
	});
});
