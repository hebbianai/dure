import { createServer } from "node:net";
import { chmodSync, lstatSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  GITHUB_READ_VERSION,
  GITHUB_READ_REQUEST_BYTES,
  GITHUB_READ_RESPONSE_BYTES,
  GITHUB_READ_CONCURRENCY,
  githubReadFrames,
  githubReadResult,
  writeGithubReadFrame,
} from "./github-read-wire.mjs";

function quote(value) {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

/** One SSH exec channel owns this private socket and every outstanding read. */
export async function serveGithubReads(root, repository) {
  const identity = lstatSync(root);
  if (!identity.isDirectory() || identity.isSymbolicLink() || (identity.mode & 0o077) !== 0)
    throw new Error("Unsafe GitHub bridge directory.");
  const socketPath = join(root, "read.sock");
  const executable = join(root, "gh");
  writeFileSync(
    executable,
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(root, "github-read-client.mjs"))} ${quote(socketPath)} "$@"\n`,
    { flag: "wx", mode: 0o700 },
  );
  const pending = new Map();
  const sockets = new Set();
  let sequence = 0;
  const errorResult = (message, code = 69) => ({
    version: GITHUB_READ_VERSION,
    code,
    stdout: "",
    stderr: `dure: ${message}\n`,
  });
  const server = createServer((socket) => {
    socket.on("error", () => {});
    if (sockets.size >= GITHUB_READ_CONCURRENCY) {
      socket.end(
        `${JSON.stringify(errorResult("GitHub share is busy; try again after the current reads finish.", 75))}\n`,
      );
      return;
    }
    sockets.add(socket);
    socket.setTimeout(30_000, () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
    const handle = async () => {
      let id;
      try {
        for await (const request of githubReadFrames(socket, GITHUB_READ_REQUEST_BYTES)) {
          if (
            request?.version !== GITHUB_READ_VERSION ||
            !Array.isArray(request.args) ||
            Object.keys(request).length !== 2
          )
            throw new Error("Invalid GitHub read request.");
          id = ++sequence;
          const response = new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject });
            socket.once("close", () => reject(new Error("GitHub client disconnected.")));
          });
          response.catch(() => {});
          await writeGithubReadFrame(process.stdout, { ...request, id }, GITHUB_READ_REQUEST_BYTES);
          await writeGithubReadFrame(socket, await response, GITHUB_READ_RESPONSE_BYTES);
          socket.end();
          return;
        }
      } catch (error) {
        if (!socket.destroyed) {
          await writeGithubReadFrame(
            socket,
            errorResult(error.message, 64),
            GITHUB_READ_RESPONSE_BYTES,
          ).catch(() => {});
          socket.end();
        }
      } finally {
        pending.delete(id);
        socket.destroy();
      }
    };
    void handle();
  });
  const disconnect = () => process.stdin.destroy();
  process.on("SIGTERM", disconnect);
  process.on("SIGINT", disconnect);
  process.stdout.on("error", disconnect);
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    chmodSync(socketPath, 0o600);
    await writeGithubReadFrame(
      process.stdout,
      { version: GITHUB_READ_VERSION, kind: "ready", repository, executable },
      GITHUB_READ_REQUEST_BYTES,
    );
    for await (const response of githubReadFrames(process.stdin, GITHUB_READ_RESPONSE_BYTES)) {
      if (
        !githubReadResult(response) ||
        !Number.isSafeInteger(response.id) ||
        response.id < 1 ||
        response.id > sequence
      )
        throw new Error("Invalid GitHub bridge reply.");
      // A client may time out or exit before its local command completes.
      pending.get(response.id)?.resolve(response);
    }
  } finally {
    process.off("SIGTERM", disconnect);
    process.off("SIGINT", disconnect);
    process.stdout.off("error", disconnect);
    for (const waiter of pending.values())
      waiter.reject(new Error("Local GitHub share disconnected."));
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    const current = lstatSync(root, { throwIfNoEntry: false });
    if (current?.dev === identity.dev && current.ino === identity.ino)
      rmSync(root, { recursive: true });
  }
}
