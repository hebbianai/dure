import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  VERSION_FILES,
  bump,
  readUnifiedVersion,
  readVersion,
  writeVersion,
} from "./lib/release-version.mjs";

const temporaryDirectories = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

/** 5개 버전 파일의 최소 형태를 가진 임시 저장소 루트를 만든다. */
function fixtureRoot(versions) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-version-"));
  temporaryDirectories.push(root);
  const v = (file) => versions[file] ?? versions.default;
  fs.mkdirSync(path.join(root, "cli"), { recursive: true });
  fs.mkdirSync(path.join(root, "src-tauri"), { recursive: true });
  fs.mkdirSync(path.join(root, "hmux"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    `{\n  "name": "dure",\n  "version": "${v("package.json")}"\n}\n`,
  );
  fs.writeFileSync(
    path.join(root, "cli/package.json"),
    `{\n  "version": "${v("cli/package.json")}"\n}\n`,
  );
  fs.writeFileSync(
    path.join(root, "src-tauri/tauri.conf.json"),
    `{\n  "productName": "Dure",\n  "version": "${v("src-tauri/tauri.conf.json")}"\n}\n`,
  );
  fs.writeFileSync(
    path.join(root, "src-tauri/Cargo.toml"),
    `[package]\nname = "dure"\nversion = "${v("src-tauri/Cargo.toml")}"\n\n[dependencies]\nserde = { version = "1" }\n`,
  );
  fs.writeFileSync(
    path.join(root, "hmux/Cargo.toml"),
    `[workspace]\nmembers = ["crates/*"]\n\n[workspace.package]\nversion = "${v("hmux/Cargo.toml")}"\n\n[workspace.dependencies]\nserde = { version = "1" }\n`,
  );
  return root;
}

describe("release version single-source", () => {
  test("bump computes patch and minor and rejects others", () => {
    expect(bump("0.1.9", "patch")).toBe("0.1.10");
    expect(bump("0.1.9", "minor")).toBe("0.2.0");
    expect(() => bump("0.1.0", "major")).toThrow();
    expect(() => bump("0.1.0-rc.1", "patch")).toThrow();
  });

  test("reads a unified version across all five files", () => {
    const root = fixtureRoot({ default: "0.3.1" });
    expect(readUnifiedVersion(root)).toBe("0.3.1");
  });

  test("rejects mismatched versions naming the offenders", () => {
    const root = fixtureRoot({ default: "0.3.1", "hmux/Cargo.toml": "0.3.0" });
    expect(() => readUnifiedVersion(root)).toThrow(/hmux\/Cargo.toml=0.3.0/);
  });

  test("writeVersion updates only the version line, format preserved", () => {
    const root = fixtureRoot({ default: "0.3.1" });
    for (const file of VERSION_FILES) writeVersion(file, "0.4.0", root);
    expect(readUnifiedVersion(root)).toBe("0.4.0");
    // Cargo.toml의 dependency version("1")은 건드리지 않는다
    const cargo = fs.readFileSync(path.join(root, "src-tauri/Cargo.toml"), "utf8");
    expect(cargo).toContain('serde = { version = "1" }');
    const workspace = fs.readFileSync(path.join(root, "hmux/Cargo.toml"), "utf8");
    expect(workspace).toContain('serde = { version = "1" }');
    // package.json의 name 필드 뒤 version만 바뀌었는지
    expect(readVersion(VERSION_FILES[0], root)).toBe("0.4.0");
  });
});
