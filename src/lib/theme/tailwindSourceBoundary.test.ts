import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { createServer, type ViteDevServer } from "vite";
import { afterEach, describe, expect, it } from "vitest";

const temporaryRoots: string[] = [];
const servers: ViteDevServer[] = [];

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.close()));
	await Promise.all(
		temporaryRoots
			.splice(0)
			.map((root) => rm(root, { force: true, recursive: true })),
	);
});

describe("Tailwind source boundary", () => {
	it("generates utilities from src without scanning nested worktrees", async () => {
		const root = await realpath(
			await mkdtemp(join(tmpdir(), "dure-tailwind-source-")),
		);
		temporaryRoots.push(root);
		await mkdir(join(root, "src"), { recursive: true });
		await mkdir(join(root, ".worktrees", "nested", "src"), { recursive: true });
		const repositoryNodeModules = await realpath(
			new URL("../../../node_modules", import.meta.url),
		);
		await symlink(
			repositoryNodeModules,
			join(root, "node_modules"),
			process.platform === "win32" ? "junction" : "dir",
		);

		const repositoryCss = await readFile(
			new URL("../../index.css", import.meta.url),
			"utf8",
		);
		await writeFile(join(root, "src", "index.css"), repositoryCss);
		// index.css pulls sibling sheets in with relative @import (the loader's
		// keyframes since 2026-09). The fixture is a copy of that one file, so
		// every sheet it names has to travel with it or Vite cannot resolve the
		// import and the boundary this test measures never gets built.
		for (const match of repositoryCss.matchAll(
			/@import\s+"(\.\/[^"]+)"/g,
		)) {
			const relative = match[1].slice(2);
			const source = await readFile(
				new URL(`../../${relative}`, import.meta.url),
				"utf8",
			);
			const destination = join(root, "src", ...relative.split("/"));
			await mkdir(dirname(destination), { recursive: true });
			await writeFile(destination, source);
		}
		await writeFile(
			join(root, "src", "inside.tsx"),
			'export const inside = "outline-dotted";',
		);
		await writeFile(
			join(root, ".worktrees", "nested", "src", "outside.tsx"),
			'export const outside = "outline-double";',
		);

		const server = await createServer({
			configFile: false,
			logLevel: "silent",
			plugins: [tailwindcss()],
			root,
			server: { middlewareMode: true },
		});
		servers.push(server);

		const transformed = await server.transformRequest("/src/index.css");
		expect(transformed?.code).toContain("outline-dotted");
		expect(transformed?.code).not.toContain("outline-double");
	});
});
