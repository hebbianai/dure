import { describe, expect, it } from "vitest";
import { encodeGitHubIssueDrag, parseGitHubIssueDrag } from "./githubIssueDrag";
import { parseGitHubWorkItem } from "./githubResponses";
import { stripDureDragPayloadPrefix } from "@/lib/platform/productDragPayload";

const project = {
	id: "project",
	name: "Dure",
	path: "/work/dure",
	kind: "local" as const,
	isRepo: true,
};
const repository = {
	projectId: project.id,
	projectName: project.name,
	path: project.path,
	nameWithOwner: "o/r",
	owner: "o",
	url: "https://github.com/o/r",
	isInOrganization: true,
};
const row = parseGitHubWorkItem(
	{ number: 42, title: "Fix refresh", url: `${repository.url}/issues/42` },
	"issue",
	repository,
)!;
const payload = () =>
	JSON.parse(stripDureDragPayloadPrefix(encodeGitHubIssueDrag(row)));

describe("GitHub issue drag boundary", () => {
	it("round trips an issue summary without exporting local paths or transcripts", () => {
		const wire = encodeGitHubIssueDrag({
			...row,
			body: "private body",
			comments: ["private comment"],
		} as typeof row);
		expect(wire).not.toContain("private");
		expect(wire).not.toContain(project.path);
		expect(parseGitHubIssueDrag(payload(), [project])).toMatchObject(row);
	});
	it("uses the registered project path even if the payload supplies another", () => {
		const value = payload();
		value.repository.path = "/untrusted/path";
		expect(parseGitHubIssueDrag(value, [project])?.repository.path).toBe(
			project.path,
		);
	});
	it.for([
		[],
		[{ ...project, kind: "ssh" as const }],
		[{ ...project, isRepo: false }],
	])("rejects unavailable local repository authority: %j", (projects) => {
		expect(parseGitHubIssueDrag(payload(), projects)).toBeNull();
	});
	it.for([
		null,
		[],
		{ type: "file" },
		{ ...payload(), issue: { ...payload().issue, number: -1 } },
		{
			...payload(),
			issue: { ...payload().issue, url: "https://github.com/o/r/pull/42" },
		},
		{
			...payload(),
			issue: {
				...payload().issue,
				url: "https://github.com/other/repo/issues/42",
			},
		},
		{ ...payload(), repository: { ...repository, url: "file:///o/r" } },
		{
			...payload(),
			repository: {
				...repository,
				url: "https://user:password@github.com/o/r",
			},
		},
	])("rejects malformed or mismatched identities: %j", (value) => {
		expect(parseGitHubIssueDrag(value, [project])).toBeNull();
	});
});
