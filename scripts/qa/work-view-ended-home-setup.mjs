import { mkdirSync, realpathSync } from "node:fs";
import path from "node:path";

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const home = realpathSync(required("HOME"));
if (home !== realpathSync(path.join(required("DURE_QA_STATE_ROOT"), "home"))) {
  throw new Error("Work view QA HOME escaped its isolated root");
}

// The probe's projects are plain local folders; no session ever exists for
// the agents bound to them, so the Host and the census both report them gone.
for (const name of ["dure", "api", "docs", "website"]) {
  mkdirSync(path.join(home, "projects", name), { mode: 0o700, recursive: true });
}
