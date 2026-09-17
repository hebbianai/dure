import { createConnection } from "node:net";
import {
  GITHUB_READ_VERSION,
  GITHUB_READ_REQUEST_BYTES,
  GITHUB_READ_RESPONSE_BYTES,
  githubReadFrames,
  githubReadResult,
  writeGithubReadFrame,
} from "./github-read-wire.mjs";

const [socketPath, ...args] = process.argv.slice(2);
let socket;
try {
  socket = createConnection(socketPath);
  socket.setTimeout(30_000, () =>
    socket.destroy(new Error("The local GitHub share did not respond.")),
  );
  // Keep an error listener installed before the async iterator starts.
  socket.on("error", () => {});
  await writeGithubReadFrame(
    socket,
    { version: GITHUB_READ_VERSION, args },
    GITHUB_READ_REQUEST_BYTES,
  );
  let received = false;
  for await (const result of githubReadFrames(socket, GITHUB_READ_RESPONSE_BYTES)) {
    if (received || !githubReadResult(result)) throw new Error("Invalid local GitHub response.");
    received = true;
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exitCode = result.code;
  }
  if (!received) throw new Error("The local GitHub share disconnected.");
} catch (error) {
  process.stderr.write(
    `dure: GitHub share unavailable: ${error.message}. Start dure github share on the local computer again.\n`,
  );
  process.exitCode = 69;
} finally {
  socket?.destroy();
}
