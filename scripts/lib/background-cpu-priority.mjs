import { getPriority, setPriority } from "node:os";

const BACKGROUND_NICE_PRIORITY = 15;

function supportsPosixNice(platform) {
  return platform === "darwin" || platform === "linux";
}

/** Converge owned work to background priority without compounding nested owners. */
export function backgroundCpuPriorityCommand(
  command,
  args,
  { platform = process.platform, readPriority = getPriority } = {},
) {
  if (!supportsPosixNice(platform)) return { command, args };
  const increment = Math.max(0, BACKGROUND_NICE_PRIORITY - readPriority());
  const loweredCommand = {
    command: "/usr/bin/nice",
    args: ["-n", String(increment), command, ...args],
  };
  if (platform !== "darwin") return loweredCommand;
  // Darwin background state also throttles inherited disk and new network I/O.
  return {
    command: "/usr/sbin/taskpolicy",
    args: ["-b", loweredCommand.command, ...loweredCommand.args],
  };
}

/** Lower a finite-work owner once, preserving any lower inherited priority. */
export function enterBackgroundCpuPriority({
  platform = process.platform,
  readPriority = getPriority,
  writePriority = setPriority,
} = {}) {
  if (!supportsPosixNice(platform)) return null;
  const previousPriority = readPriority();
  const priority = Math.max(previousPriority, BACKGROUND_NICE_PRIORITY);
  if (priority !== previousPriority) writePriority(priority);
  return { previousPriority, priority };
}
