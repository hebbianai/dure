#!/usr/bin/env node
// Tauri updater 매니페스트(latest.json) 생성 — 피드 repo 릴리스 자산을 가리킨다.
// 사용: node scripts/build-latest-json.mjs <version> <sig-file> <asset-name> <feed-repo>
// 예:   node scripts/build-latest-json.mjs 0.1.2 path/to/app.tar.gz.sig \
//         Hebbian_0.1.2_aarch64.app.tar.gz hebbianai/hebbian-releases
import { readFileSync, writeFileSync } from "node:fs";

const [version, sigPath, assetName, feedRepo, channel = "stable"] = process.argv.slice(2);
if (!version || !sigPath || !assetName || !feedRepo) {
  console.error("usage: build-latest-json.mjs <version> <sig-file> <asset-name> <feed-repo>");
  process.exit(2);
}
if (channel !== "stable" && channel !== "beta") {
  throw new Error("unsupported release distribution channel");
}

const manifest = {
  ...(channel === "beta" ? { channel } : {}),
  version,
  pub_date: new Date().toISOString(),
  platforms: {
    "darwin-aarch64": {
      signature: readFileSync(sigPath, "utf8").trim(),
      url: `https://github.com/${feedRepo}/releases/download/v${version}/${assetName}`,
    },
  },
};

writeFileSync("latest.json", `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`latest.json -> v${version} (${assetName})`);
