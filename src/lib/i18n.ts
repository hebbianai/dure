import { en } from "@/locales/en";

/** 다국어 처리 — 두 키 클래스가 각자 하나의 결정적 체인을 가진다.
 *
 *  ## semantic ID (이관 목표 형태, AGENTS 헌장)
 *  점 표기 lowerCamel 경로("terminal.retiredPane.close")가 키다.
 *  체인: 현재 언어 카탈로그 → 정본 en 카탈로그 → ID 리터럴(개발에서 실패가
 *  보이게). ko도 명시 카탈로그(src/locales/ko/)를 가지며 다른 언어처럼
 *  지연 로드된다.
 *
 *  이관 절차(기능 경계 단위 원자적으로): ① en/<fragment>에 ID 키 추가,
 *  한국어 원문은 ko/<fragment>로 ② es·fr·pt·ja·zh의 한국어 키를 ID로 교체
 *  ③ 호출부 t()를 ID로 ④ 옛 한국어 키 항목을 모든 카탈로그에서 삭제.
 *  영어 산문을 키로 쓰지 말 것 — ID만.
 *
 *  ## legacy 한국어-문장 키 (데이터 기반 동적 키 전용)
 *  2026-08-17 이관 완료 — 리터럴 한국어 t() 키는 koreanLeakGate가 0으로
 *  잠근다. 이 체인은 플러그인 manifest·hub wire 키처럼 데이터가 키를
 *  공급하는 경로만 남는다.
 *  - ko: t()가 원문을 그대로 반환 (사전 불필요)
 *  - 그 외 언어: src/locales/<lang>.ts 에서 조회, 없으면 한국어 폴백
 *    (미번역이 눈에 보임). en은 부팅 번들에 포함(기본 폴백 언어), 나머지는
 *    지연 로드 — useAppLanguage가 ensureLangLoaded 후 리마운트한다.
 *
 *  공통: 보간은 "{name}" 자리표시자 — t("app.confirm.removeNamed", { name }).
 *  언어 변경은 App 루트의 key 리마운트로 전파되므로 컴포넌트가 store를
 *  구독할 필요 없이 렌더 시점에 t()만 호출하면 된다.
 */

/** 점 표기 semantic ID 판별 — 기존 라벨형 영문 키("AI", "Codex · rate
 *  limit")는 공백·중점 때문에 매치되지 않아 legacy 체인에 남는다. */
const SEMANTIC_ID = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;

export type Lang = "ko" | "en" | "zh" | "ja" | "es" | "fr" | "pt";
export type LangSetting = "system" | Lang;

let current: Lang = "ko";

const dictionaries: Partial<Record<Lang, Record<string, string>>> = { en };

const loaders: Record<Exclude<Lang, "en">, () => Promise<Record<string, string>>> = {
  ko: () => import("@/locales/ko").then((m) => m.ko),
  zh: () => import("@/locales/zh").then((m) => m.zh),
  ja: () => import("@/locales/ja").then((m) => m.ja),
  es: () => import("@/locales/es").then((m) => m.es),
  fr: () => import("@/locales/fr").then((m) => m.fr),
  pt: () => import("@/locales/pt").then((m) => m.pt),
};

/** 해당 언어 사전이 메모리에 있게 한다. en은 즉시 resolve. */
export async function ensureLangLoaded(lang: Lang): Promise<void> {
  if (lang === "en" || dictionaries[lang]) return;
  dictionaries[lang] = await loaders[lang]();
}

export function isLangLoaded(lang: Lang): boolean {
  return dictionaries[lang] !== undefined;
}

export function resolveLang(setting: LangSetting): Lang {
  // 명시적으로 고르지 않았으면 언제나 영어다 (사용자 지시 2026-08-02).
  // 이전에는 OS 로케일을 따라가 한국어 macOS에서 기본이 ko가 됐는데,
  // 이 제품의 기본 표시 언어는 시스템과 무관하게 English다. 기존에
  // 저장된 "system" 값도 이 규칙으로 해석돼 즉시 영어가 된다.
  if (setting === "system") return "en";
  return setting;
}

export function setLang(l: Lang) {
  current = l;
}

export function t(key: string, vars?: Record<string, string | number>): string {
  let s: string;
  if (SEMANTIC_ID.test(key)) {
    s = dictionaries[current]?.[key] ?? en[key] ?? key;
  } else {
    s = current === "ko" ? key : (dictionaries[current]?.[key] ?? key);
  }
  if (vars) {
    for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  }
  return s;
}
