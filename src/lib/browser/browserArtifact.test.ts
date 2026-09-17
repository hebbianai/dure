import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
	downloadBrowserImage,
	parseBrowserImageArtifact,
} from "./browserArtifact";

const page = {
	resource: {
		resource_id: "browser:one",
		generation: "generation:one",
		workspace_id: "workspace:one",
	},
	page_id: "page:one",
	document_revision: "1",
};
function fixture(size = 70_000) {
	const bytes = Buffer.alloc(size, 37);
	const artifact = {
		page,
		mimeType: "image/png" as const,
		size,
		sha256: createHash("sha256").update(bytes).digest("hex"),
	};
	const part = (offset: number) => ({
		artifact,
		offset,
		base64: bytes.subarray(offset, offset + 65536).toString("base64"),
		eof: offset + 65536 >= size,
	});
	return { bytes, artifact, part };
}
it("reassembles an image larger than the response carrier with ordered immutable chunks", async () => {
	const { bytes, artifact, part } = fixture(2 * 1024 * 1024 + 7);
	const read = vi.fn(async (offset: number) => part(offset));
	expect(await downloadBrowserImage(read, artifact)).toBe(
		bytes.toString("base64"),
	);
	expect(read.mock.calls.map(([offset]) => offset)).toEqual(
		Array.from({ length: 33 }, (_, i) => i * 65536),
	);
});
it.each([
	{ size: 64 * 1024 * 1024 + 1 },
	{ size: 0 },
	{ size: 1.5 },
	{ mimeType: "text/html" },
	{ sha256: "invalid" },
	{ page: null },
])("rejects an invalid image manifest %j before allocating", (change) => {
	expect(
		parseBrowserImageArtifact({ ...fixture().artifact, ...change }),
	).toBeUndefined();
});
it.each([
	{ offset: 1 },
	{ base64: "" },
	{ base64: "%%%=" },
	{ base64: "Zh==" },
	{ eof: true },
])("rejects an inconsistent chunk without reading again %j", async (change) => {
	const { artifact, part } = fixture();
	const read = vi.fn(async () => ({ ...part(0), ...change }));
	await expect(downloadBrowserImage(read, artifact)).rejects.toThrow(
		"browser_artifact_invalid",
	);
	expect(read).toHaveBeenCalledTimes(1);
});
it.each(["page", "digest", "size"])(
	"rejects changed %s metadata between chunks",
	async (change) => {
		const { artifact, part } = fixture();
		const other = {
			...artifact,
			...(change === "page"
				? { page: { ...page, document_revision: "2" } }
				: change === "digest"
					? { sha256: "a".repeat(64) }
					: { size: artifact.size + 1 }),
		};
		const read = vi.fn(async (offset: number) => ({
			...part(offset),
			artifact: offset ? other : artifact,
		}));
		await expect(downloadBrowserImage(read, artifact)).rejects.toThrow(
			"browser_artifact_invalid",
		);
		expect(read).toHaveBeenCalledTimes(2);
	},
);
it("rejects corrupted bytes after receiving a complete image", async () => {
	const { artifact, part } = fixture(3);
	await expect(
		downloadBrowserImage(
			async () => ({ ...part(0), base64: "YmFk" }),
			artifact,
		),
	).rejects.toThrow("browser_artifact_digest_mismatch");
});
it("stops reads after cancellation during a chunk without returning a partial image", async () => {
	const { artifact, part } = fixture();
	const lifetime = new AbortController();
	const read = vi.fn(async (offset: number) => {
		lifetime.abort();
		return part(offset);
	});
	await expect(
		downloadBrowserImage(read, artifact, lifetime.signal),
	).rejects.toThrow();
	expect(read).toHaveBeenCalledTimes(1);
});
