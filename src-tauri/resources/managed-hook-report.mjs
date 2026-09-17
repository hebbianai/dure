import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";

export async function reportManagedHook(runtime, normalize, label) {
  try {
    process.stdin.setEncoding("utf8");
    let input = "";
    for await (const bytes of process.stdin) {
      input += bytes;
      if (Buffer.byteLength(input) > 1024 * 1024) throw new Error("Provider hook input exceeds the report limit");
    }
    const request = normalize(JSON.parse(input), process.env);
    if (!request || !isAbsolute(runtime)) return;
    const payload = Buffer.from(JSON.stringify(request));
    const frame = Buffer.alloc(4 + payload.length);
    frame.writeUInt32BE(payload.length); payload.copy(frame, 4);
    await new Promise((resolve, reject) => {
      const child = execFile(runtime, ["--no-autostart", "internal-hmux-managed-agent-state-report"],
        { timeout: 2000, maxBuffer: 64 * 1024, encoding: "buffer" },
        (error, output) => {
          if (error) return reject(error);
          try {
            const result = JSON.parse(output.subarray(4).toString());
            if (result.state !== "completed") throw new Error("Provider Host report was refused");
            resolve();
          } catch (failure) { reject(failure); }
        });
      child.stdin.on("error", reject);
      child.stdin.end(frame);
    });
  } catch (error) {
    process.stderr.write(`Dure ${label} lifecycle: ${error.message}\n`);
  } finally {
    // A lifecycle observer must not approve, reject or rewrite provider work.
    process.stdout.write("{}");
  }
}
