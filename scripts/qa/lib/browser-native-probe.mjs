import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";

// QA-only access to the pinned engine's Unix protocol. Product clients must
// submit through the Host's resource and input authority instead.
export function probeBrowserNative(socketPath, command) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let received = "";
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(10_000, () =>
      finish(new Error("native probe timed out")),
    );
    socket.on("connect", () =>
      socket.write(`${JSON.stringify({ id: randomUUID(), ...command })}\n`),
    );
    socket.on("error", (error) => finish(error));
    socket.on("end", () =>
      finish(new Error("native probe closed before response")),
    );
    socket.on("data", (chunk) => {
      received += chunk;
      if (Buffer.byteLength(received) > 4 * 1024 * 1024) {
        finish(new Error("native probe response exceeds 4 MiB"));
        return;
      }
      const newline = received.indexOf("\n");
      if (newline < 0) return;
      try {
        finish(undefined, JSON.parse(received.slice(0, newline)));
      } catch (error) {
        finish(error);
      }
    });
  });
}
