import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseMetadata } from "./dure-cli-channel-launcher.mjs";
import { promoteDureCli, reconcileDureCliLauncher } from "./dure-cli-promotion.mjs";
import { runEntryPoint } from "./process-exit.mjs";
import { assertNotRetainedAppBackup, reconcileRetainedAppBackups } from "./retained-app-backups.mjs";

function bootstrap() {
  const sourceVersionDirectory = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  const [home, channel] = process.argv.slice(2);
  const metadata = parseMetadata(sourceVersionDirectory);
  if (
    !home || !home.startsWith("/") || channel !== "stable" ||
    metadata.bundle.app.channel !== channel ||
    metadata.bundle.app.schemaVersion !== 2 ||
    metadata.bundle.hmux.schemaVersion !== 2 ||
    metadata.bundle.hmux.channel !== channel
  ) {
    throw new Error("packaged Dure CLI bootstrap requires an exact-source stable bundle");
  }
  // A retained backup copy must not become the source of shared state. The app
  // publishes its descriptor and hook scripts only after this bootstrap succeeds.
  assertNotRetainedAppBackup({ sourcePath: sourceVersionDirectory, home });
  const installRoot = join(home, ".local", "share", "hebbian-ide-cli");
  const receipt = promoteDureCli({
    sourceVersionDirectory,
    installRoot,
    commandDirectory: join(installRoot, "bin"),
    reconcileManaged: true,
  });
  reconcileDureCliLauncher({
    sourceVersionDirectory,
    installRoot,
    commandDirectory: join(home, ".local", "bin"),
  });
  const retainedAppBackups = reconcileRetainedAppBackups({ home });
  process.stdout.write(`${JSON.stringify({ ...receipt, retainedAppBackups })}\n`);
}

// Verifying the payload hashes large files such as bin/node, so a refusal used
// to leave through Node's fast exit path while a V8 compile waited for a GC;
// the process never exited and the app saw a bootstrap timeout (#549).
await runEntryPoint(bootstrap);
