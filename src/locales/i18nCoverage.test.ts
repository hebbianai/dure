// i18n 커버리지 게이트 — src/ 의 모든 t("…") 키가 합성된 영어 사전에 있어야 한다.
// 영어 모드에서 한국어가 새는 회귀(2026-07-30 사용자 보고)를 push 전에 끊는다.
// 소스 텍스트를 정적으로 스캔하므로 렌더 없이 수 백 ms에 끝난다.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { en } from "./en";
import { ko } from "./ko";
import { es } from "./es";
import { fr } from "./fr";
import { ja } from "./ja";
import { pt } from "./pt";
import { zh } from "./zh";

const SRC_ROOT = join(__dirname, "..");

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* walk(full);
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      yield full;
    }
  }
}

/** 소스의 t("…") 리터럴 키를 소스 표기 그대로 수집한 뒤 JS 문자열로 해석한다. */
function collectUsedKeys(): Map<string, string[]> {
  const used = new Map<string, string[]>();
  const call = /\bt\(\s*"((?:[^"\\]|\\.)*)"/g;
  for (const file of walk(SRC_ROOT)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(call)) {
      // 이스케이프(\n 등)를 런타임 문자열로 — en 사전 키와 같은 형태로 만든다.
      const key = JSON.parse(`"${match[1]}"`) as string;
      const files = used.get(key) ?? [];
      files.push(file.slice(SRC_ROOT.length + 1));
      used.set(key, files);
    }
  }
  collectBundledPluginKeys(used);
  return used;
}

/** 번들 플러그인(plugins/**)의 매니페스트·기여 JSON은 title/description/label
 *  문자열을 t()의 **동적 키**로 흘려보낸다(DurePluginsPane의
 *  t(pluginDescription(...)), DurePluginSettingsDialog의 t(definition.title)).
 *  정적 스캔이 못 보는 이 키들도 사전 커버리지에 넣는다 — 2026-08-15에
 *  미사용 키 정리가 이 경로의 en 항목을 지워 영어 모드에 한국어가 새는
 *  회귀가 실제로 났다. translations 맵 안의 값은 키가 아니므로 제외한다. */
function collectBundledPluginKeys(used: Map<string, string[]>): void {
  const pluginsRoot = join(SRC_ROOT, "..", "plugins");
  const collect = (value: unknown, file: string, underTranslations: boolean) => {
    if (typeof value === "string") {
      if (!underTranslations && /[가-힣]/.test(value)) {
        const files = used.get(value) ?? [];
        files.push(file);
        used.set(value, files);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) collect(item, file, underTranslations);
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        collect(child, file, underTranslations || key === "translations");
      }
    }
  };
  const jsonFiles: string[] = [];
  const walkJson = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walkJson(full);
      else if (entry.endsWith(".json")) jsonFiles.push(full);
    }
  };
  walkJson(pluginsRoot);
  for (const file of jsonFiles) {
    collect(
      JSON.parse(readFileSync(file, "utf8")),
      `plugins/${file.slice(pluginsRoot.length + 1)}`,
      false,
    );
  }
}

const DICTIONARIES: Record<string, Record<string, string>> = { en, zh, ja, es, fr, pt };

/** semantic ID(점 표기 lowerCamel — i18n.ts와 같은 판별)는 정본 en에 더해
 *  명시 ko까지 일곱 카탈로그 전부에 있어야 한다. legacy 한국어-문장 키는
 *  ko 원문이 곧 표시라 여섯 개면 된다. */
const SEMANTIC_ID = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;
const SEMANTIC_DICTIONARIES: Record<string, Record<string, string>> = {
	...DICTIONARIES,
	ko,
};

describe("i18n coverage", () => {
  for (const [name, dictionary] of Object.entries(DICTIONARIES)) {
    it(`모든 t() 키에 ${name} 번역이 있다`, () => {
      const missing: string[] = [];
      for (const [key, files] of collectUsedKeys()) {
        if (!/[가-힣]/.test(key)) continue; // 영문/기호 키는 그대로 노출돼도 무해
        if (dictionary[key] === undefined) missing.push(`${key}  ← ${files[0]}`);
      }
      expect(
        missing,
        `${name}.ts에 번역이 없는 키 ${missing.length}개:\n${missing.join("\n")}`,
      ).toEqual([]);
    });
  }
});

describe("semantic ID coverage", () => {
  for (const [name, dictionary] of Object.entries(SEMANTIC_DICTIONARIES)) {
    it(`모든 semantic ID에 ${name} 카탈로그 항목이 있다`, () => {
      const missing: string[] = [];
      for (const [key, files] of collectUsedKeys()) {
        if (!SEMANTIC_ID.test(key)) continue;
        if (dictionary[key] === undefined) missing.push(`${key}  ← ${files[0]}`);
      }
      expect(
        missing,
        `${name} 카탈로그에 없는 semantic ID ${missing.length}개:\n${missing.join("\n")}`,
      ).toEqual([]);
    });
  }
});
