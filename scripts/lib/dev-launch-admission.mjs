import { requireProcessGroupAdmission } from "./process-group-authority.mjs";

export async function requireDevLaunchAdmission() {
  const processGroup = await requireProcessGroupAdmission();
  if (process.platform !== "win32" && typeof process.execve !== "function") {
    const error = new Error(
      "development app activation requires process.execve",
    );
    error.code = "DEV_LAUNCH_ACTIVATION_UNSUPPORTED";
    throw error;
  }
  return processGroup;
}
