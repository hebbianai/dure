import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("interactive SSH registration CLI receipt", () => {
	it.each([409, 503])(
		"preserves original argv and SSH exit status for fallback HTTP %i",
		async (status) => {
			const root = mkdtempSync(join(tmpdir(), "dure-ssh-fallback-"));
			const capture = join(root, "ssh.json");
			const hook = join(root, "spawn-hook.mjs");
			const requests = [];
			const server = createServer(async (request, response) => {
				const chunks = [];
				for await (const chunk of request) chunks.push(chunk);
				requests.push({
					path: request.url,
					body: JSON.parse(Buffer.concat(chunks)),
				});
				response.writeHead(status, { "Content-Type": "application/json" });
				response.end(JSON.stringify({ ok: false, fallback: true }));
			});
			try {
				await new Promise((resolve, reject) => {
					server.once("error", reject);
					server.listen(0, "127.0.0.1", resolve);
				});
				writeFileSync(
					join(root, "server.json"),
					JSON.stringify({
						port: server.address().port,
						token: "fixture-only",
					}),
				);
				// Observe the existing OS spawn boundary without starting SSH or reading
				// the developer's SSH config/known_hosts. No product execution seam changes.
				writeFileSync(
					hook,
					`import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
cp.spawn = (command, argv, options) => {
  if (command !== "/usr/bin/ssh") throw new Error("unexpected process");
  writeFileSync(process.env.QA_SSH_CAPTURE, JSON.stringify({ command, argv, stdio: options.stdio }), { flag: "wx" });
  const child = new EventEmitter();
  queueMicrotask(() => child.emit("exit", 23, null));
  return child;
};
syncBuiltinESMExports();\n`,
				);
				const argv = ["qa@192.0.2.20", "-p", "2222"];
				const result = await new Promise((resolveResult) =>
					execFile(
						process.execPath,
						["--import", hook, resolve("cli/dure.mjs"), "__ssh", ...argv],
						{
							cwd: root,
							timeout: 5_000,
							env: {
								PATH: process.env.PATH,
								HOME: root,
								DURE_HOME: root,
								DURE_APP_CHANNEL: "stable",
								HMUX_SESSION_ID: "standalone_qa",
								HMUX_WORKSPACE_ID: "workspace_qa",
								QA_SSH_CAPTURE: capture,
							},
						},
						(error, stdout, stderr) => resolveResult({ error, stdout, stderr }),
					),
				);
				expect(result.error?.code).toBe(23);
				expect(result.stderr).toBe("");
				expect(JSON.parse(readFileSync(capture, "utf8"))).toEqual({
					command: "/usr/bin/ssh",
					argv,
					stdio: "inherit",
				});
				expect(requests).toEqual([
					{
						path: "/hmux/remote-shell",
						body: {
							sourceSessionId: "standalone_qa",
							sourceWorkspaceId: "workspace_qa",
							argv,
							destination: { host: "192.0.2.20", user: "qa", port: 2222 },
						},
					},
				]);
			} finally {
				await new Promise((resolve) => server.close(resolve));
				rmSync(root, { recursive: true, force: true });
			}
		},
	);
});
