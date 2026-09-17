import { copyFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Tauri signs libraries in Contents/Frameworks before sealing the outer app.
// Keep the package-store bytes immutable; sign only the bundled copy.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = resolve(root, "src-tauri/resources/mobile-runtime");
const source = new URL("./native/serve-sim-native.node", import.meta.resolve("serve-sim/middleware"));
mkdirSync(directory, { recursive: true });
const temporary = resolve(directory, `serve-sim-native-${process.pid}.dylib`);
copyFileSync(source, temporary);
renameSync(temporary, resolve(directory, "serve-sim-native.dylib"));
