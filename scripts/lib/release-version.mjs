// The release workflow advances these manifests as one version set.
// DURE_BUILD_ID distinguishes source revisions within that package version.
import { readFileSync, writeFileSync } from "node:fs";

export const VERSION_FILES = [
  { path: "package.json", kind: "json" },
  { path: "cli/package.json", kind: "json" },
  { path: "src-tauri/tauri.conf.json", kind: "json" },
  { path: "src-tauri/Cargo.toml", kind: "cargo-package" },
  { path: "hmux/Cargo.toml", kind: "cargo-workspace" },
];

const SEMVER = /^\d+\.\d+\.\d+$/;

export function parseVersion(text) {
  if (!SEMVER.test(text)) throw new Error(`not a plain semver: ${text}`);
  return text.split(".").map(Number);
}

export function bump(version, kind) {
  const [major, minor, patch] = parseVersion(version);
  if (kind === "patch") return `${major}.${minor}.${patch + 1}`;
  if (kind === "minor") return `${major}.${minor + 1}.0`;
  throw new Error(`unsupported bump kind: ${kind} (patch|minor only)`);
}

export function readVersion(file, root = ".") {
  const text = readFileSync(`${root}/${file.path}`, "utf8");
  return readVersionText(file, text);
}

export function readVersionText(file, text) {
  if (file.kind === "json") {
    const value = JSON.parse(text).version;
    if (typeof value !== "string") throw new Error(`${file.path}: version 필드 없음`);
    return value;
  }
  // Cargo.toml — 첫 [package]/[workspace.package] 섹션의 version 키만 본다.
  const section = file.kind === "cargo-package" ? "[package]" : "[workspace.package]";
  const match = sectionBody(text, section).match(/^version\s*=\s*"([^"]+)"/m);
  if (!match) throw new Error(`${file.path}: ${section} version 없음`);
  return match[1];
}

export function writeVersion(file, next, root = ".") {
  const path = `${root}/${file.path}`;
  const text = readFileSync(path, "utf8");
  writeFileSync(path, replaceVersion(file, text, next));
}

/** Replace only the manifest's version field, preserving every unrelated byte. */
export function replaceVersion(file, text, next) {
  parseVersion(next);
  if (file.kind === "json") {
    const updated = text.replace(
      /("version"\s*:\s*")[^"]+(")/,
      `$1${next}$2`,
    );
    if (JSON.parse(updated).version !== next) throw new Error("release_version_field_not_updated: " + file.path);
    return updated;
  }
  const section = file.kind === "cargo-package" ? "[package]" : "[workspace.package]";
  const body = sectionBody(text, section);
  const updatedBody = body.replace(/^(version\s*=\s*")[^"]+(")/m, `$1${next}$2`);
  return text.replace(body, updatedBody);
}

function sectionBody(text, header) {
  const start = text.indexOf(header);
  if (start < 0) throw new Error(`section ${header} not found`);
  const rest = text.slice(start + header.length);
  const end = rest.search(/^\[/m);
  return end < 0 ? rest : rest.slice(0, end);
}

/** 5개 파일이 모두 같은 버전인지 확인하고 그 버전을 반환한다. */
export function readUnifiedVersion(root = ".") {
  const versions = VERSION_FILES.map((file) => ({ file: file.path, version: readVersion(file, root) }));
  const unique = [...new Set(versions.map((v) => v.version))];
  if (unique.length !== 1) {
    const detail = versions.map((v) => `${v.file}=${v.version}`).join(", ");
    throw new Error(`버전 불일치: ${detail}`);
  }
  return unique[0];
}
