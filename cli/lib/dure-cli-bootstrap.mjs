import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseMetadata } from "./dure-cli-channel-launcher.mjs";
import { promoteDureCli, reconcileDureCliLauncher } from "./dure-cli-promotion.mjs";

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
process.stdout.write(`${JSON.stringify(receipt)}\n`);
