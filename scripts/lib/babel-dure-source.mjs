/**
 * JSX DOM 요소에 `data-dure-src="<파일>:<줄>"`을 심는 babel 플러그인 (dev 전용).
 *
 * Design Mode가 집은 요소의 소스 위치를 에이전트에게 함께 주기 위한 것이다 —
 * 그러면 에이전트가 파일을 찾는 왕복이 사라진다. React 19에서 `_debugSource`가
 * 제거돼 런타임에서 알아낼 방법이 없으므로 빌드 시 심는다.
 *
 * 규칙과 그 이유:
 * - **소문자 태그만.** 대문자는 컴포넌트이고, 거기에 넣으면 DOM에 닿지 않는 채
 *   prop으로 흘러가 아무 값도 없이 컴포넌트 계약만 오염된다.
 * - **이미 있으면 덮지 않는다.** 손으로 적은 값이 이긴다.
 * - **프로덕션 빌드에는 넣지 않는다**(호출자가 dev에서만 등록한다). 모든 요소에
 *   파일 경로가 박히면 용량이 늘고 내부 구조가 그대로 노출된다.
 */

export const SOURCE_ATTRIBUTE = "data-dure-src";

/** 절대 경로를 저장소 기준 상대 경로로. 밖의 파일이면 파일명만 남긴다 —
 *  사용자 홈 경로를 프롬프트에 흘리지 않는다. */
export function sourceLabel(filename, line, root) {
  if (!filename) return undefined;
  const normalized = filename.replaceAll("\\", "/");
  const base = root ? `${root.replaceAll("\\", "/").replace(/\/$/, "")}/` : "";
  const relative = base && normalized.startsWith(base)
    ? normalized.slice(base.length)
    : normalized.split("/").pop();
  if (!relative) return undefined;
  return typeof line === "number" ? `${relative}:${line}` : relative;
}

/** 이 태그에 심어야 하는지. 소문자로 시작하는 것만 DOM 태그다(JSX 규칙) —
 *  `<my-element>` 같은 커스텀 엘리먼트도 DOM이므로 포함된다. */
export function shouldAnnotate(tagName, existingAttributeNames) {
  if (typeof tagName !== "string" || !/^[a-z]/.test(tagName)) return false;
  return !existingAttributeNames.includes(SOURCE_ATTRIBUTE);
}

export default function dureSourcePlugin({ types }, options = {}) {
  const root = options.root;
  return {
    name: "dure-source",
    visitor: {
      JSXOpeningElement(path, state) {
        const nameNode = path.node.name;
        if (nameNode?.type !== "JSXIdentifier") return;
        const existing = path.node.attributes
          .filter((attribute) => attribute.type === "JSXAttribute")
          .map((attribute) => attribute.name?.name)
          .filter((name) => typeof name === "string");
        if (!shouldAnnotate(nameNode.name, existing)) return;
        const label = sourceLabel(
          state.filename ?? state.file?.opts?.filename,
          path.node.loc?.start?.line,
          root,
        );
        if (!label) return;
        // 맨 앞에 넣는다 — 뒤에 오는 spread나 명시적 속성이 이기게 한다.
        path.node.attributes.unshift(
          types.jsxAttribute(
            types.jsxIdentifier(SOURCE_ATTRIBUTE),
            types.stringLiteral(label),
          ),
        );
      },
    },
  };
}
