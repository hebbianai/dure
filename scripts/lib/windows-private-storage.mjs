import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const boundary = fileURLToPath(
  new URL("../native/windows-private-storage.ps1", import.meta.url),
);

export function windowsPrivateStorage(request) {
  // Windows PowerShell supplies the .NET Framework atomic ACL constructors.
  // Payload bytes use stdin, never process arguments or diagnostic output.
  const result = spawnSync("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", boundary,
  ], {
    input: JSON.stringify(request),
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Windows private storage failed: ${
      result.error?.message || result.stderr.trim() || `exit ${result.status}`
    }`);
  }
}
