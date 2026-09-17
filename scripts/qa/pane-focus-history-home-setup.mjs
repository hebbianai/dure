import fs from "node:fs";
import path from "node:path";

const root = fs.realpathSync(process.env.DURE_QA_STATE_ROOT);
if (fs.realpathSync(process.env.HOME) !== path.join(root, "home")) {
  throw new Error("pane focus QA HOME escaped its isolated root");
}
// Shadow any legacy checkout flag before Vite or a WebView starts.
fs.writeFileSync(path.join(root, "qa.autorun"), "", { flag: "wx", mode: 0o600 });
