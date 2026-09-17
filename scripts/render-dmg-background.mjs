#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

// Finder needs both resolutions in one TIFF to keep the instruction sharp on Retina.
const icons = fileURLToPath(new URL("../src-tauri/icons/", import.meta.url));
const artwork = await readFile(path.join(icons, "dmg-background.svg"), "utf8");
const temporary = await mkdtemp(path.join(tmpdir(), "dure-dmg-art-"));
const images = ["background.png", "background@2x.png"].map((name) =>
  path.join(temporary, name),
);
let browser;
try {
  browser = await chromium.launch({ headless: true });
  for (const scale of [1, 2]) {
    const page = await browser.newPage({
      viewport: { width: 680, height: 420 },
      deviceScaleFactor: scale,
    });
    await page.setContent(
      `<style>html,body{margin:0;overflow:hidden}</style>${artwork}`,
    );
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: images[scale - 1] });
    await page.close();
  }
  execFileSync("/usr/bin/tiffutil", [
    "-cathidpicheck",
    ...images,
    "-out",
    path.join(icons, "dmg-background.tiff"),
  ]);
} finally {
  await browser?.close();
  for (const image of images) {
    await unlink(image).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  await rmdir(temporary);
}
