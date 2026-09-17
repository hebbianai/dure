import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { renderToString } from "react-dom/server";
import { App, h } from "./fixture.mjs";

// Resolve the bundler from its actual installed consumer and use the existing
// lockfile's React packages. The native QA launcher owns build admission.
const require = createRequire(import.meta.url);
const viteRequire = createRequire(require.resolve("vite/package.json"));
const { build } = viteRequire("esbuild");
const mode = process.argv[2];
if (!["development", "production"].includes(mode)) throw new Error("fixture mode required");
const bundled = await build({
  stdin: {
    contents: 'import { hydrateRoot } from "react-dom/profiling"; import { App, h } from "./fixture.mjs"; hydrateRoot(document.getElementById("root"), h(App));',
    resolveDir: fileURLToPath(new URL(".", import.meta.url)),
  },
  bundle: true,
  write: false,
  platform: "browser",
  keepNames: true,
  define: { "process.env.NODE_ENV": JSON.stringify(mode) },
});
process.stdout.write(JSON.stringify({
  react: require("react/package.json").version,
  reactDom: require("react-dom/package.json").version,
  mode,
  markup: renderToString(h(App)),
  source: bundled.outputFiles[0].text,
}));
