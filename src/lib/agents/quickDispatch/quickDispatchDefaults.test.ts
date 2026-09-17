import { describe, expect, it } from "vitest";
import { resolveQuickDispatchProject } from "@/lib/agents/quickDispatch/quickDispatchDefaults";
import { agentFixture } from "@/test/agentFixtures";

const projects = [
	{
		id: "p1",
		name: "A",
		path: "/repo/a",
		kind: "local" as const,
		isRepo: true,
	},
	{
		id: "p2",
		name: "B",
		path: "/repo/b",
		kind: "local" as const,
		isRepo: true,
	},
];
const agents = [
	agentFixture({
		id: "ag1",
		projectId: "p2",
		worktreePath: "/repo/b/.worktrees/x",
	}),
];

describe("resolveQuickDispatchProject", () => {
	it("uses the focused agent panel's project", () => {
		const project = resolveQuickDispatchProject({
			focusCtx: {
				key: "agent:ag1",
				agentId: "ag1",
				cwd: "/repo/b/.worktrees/x",
				source: "local",
				label: "x",
			},
			agents,
			projects,
		});
		expect(project?.id).toBe("p2");
	});
	it.each(["slot", "agent:previous", "launcher:previous"])(
		"uses the explicit Agent context in %s independently of cwd matching",
		(key) => {
			const focusCtx = {
				key,
				agentId: "ag1",
				cwd: "/outside",
				source: "local" as const,
				label: "working",
			};
			expect(
				resolveQuickDispatchProject({ focusCtx, agents, projects })?.id,
			).toBe("p2");
		},
	);
	it("does not infer an Agent from a terminal's historical key", () => {
		const focusCtx = {
			key: "agent:ag1",
			cwd: "/outside",
			source: "local" as const,
			label: "shell",
		};
		expect(
			resolveQuickDispatchProject({ focusCtx, agents, projects })?.id,
		).toBe("p1");
	});
	it("matches by cwd prefix when the pane is not an agent", () => {
		const project = resolveQuickDispatchProject({
			focusCtx: { cwd: "/repo/b/src", source: "local", label: "b" },
			agents: [],
			projects,
		});
		expect(project?.id).toBe("p2");
	});
	it("falls back to the first local project, then null", () => {
		expect(
			resolveQuickDispatchProject({ focusCtx: null, agents: [], projects })?.id,
		).toBe("p1");
		expect(
			resolveQuickDispatchProject({ focusCtx: null, agents: [], projects: [] }),
		).toBeNull();
	});
});


describe("SSH Quick Dispatch defaults", () => {
 const remote = { ...projects[1], id: "remote", kind: "ssh" as const, sshHostId: "host-a" };
 const other = { ...remote, id: "other", sshHostId: "host-b" };
 it("matches the deepest project on the focused SSH host", () => {
  const nested = { ...remote, id: "nested", path: "/repo/b/pkg" };
  expect(resolveQuickDispatchProject({ focusCtx: { cwd: "/repo/b/pkg/src", source: "ssh", hostId: "host-a", label: "remote" }, agents: [], projects: [...projects, other, remote, nested] })).toEqual(nested);
 });
 it("never substitutes a local or another host's project for unmatched SSH focus", () => {
  for (const hostId of [undefined, "host-a", "missing"]) {
   expect(resolveQuickDispatchProject({ focusCtx: { cwd: "/repo/b", source: "ssh", hostId, label: "remote" }, agents: [], projects: [...projects, other] })).toBeNull();
  }
 });
 it("offers the first SSH project when there is no focus and no local project", () => {
  expect(resolveQuickDispatchProject({ focusCtx: null, agents: [], projects: [remote] })).toEqual(remote);
 });
});
