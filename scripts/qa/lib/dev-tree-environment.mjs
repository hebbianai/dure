import { join } from "node:path";

export function devTreeEnvironment(root, channel, source = process.env) {
  const environment = Object.fromEntries(
    ["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "LOCALAPPDATA"]
      .filter((name) => source[name] !== undefined)
      .map((name) => [name, source[name]]),
  );
  return {
    ...environment,
    HOME: root, USERPROFILE: root, TEMP: root, TMP: root, TMPDIR: root,
    DURE_HOME: root, DURE_APP_CHANNEL: channel,
    HMUX_DISCOVERY_ROOT: join(root, "unused-hmux-discovery"),
  };
}
