import { describe, expect, it, vi } from "vitest";
import dureSourcePlugin, {
  SOURCE_ATTRIBUTE,
  shouldAnnotate,
  sourceLabel,
} from "./babel-dure-source.mjs";

const ROOT = "/repo";

describe("sourceLabel", () => {
  it("저장소 기준 상대 경로와 줄 번호를 만든다", () => {
    expect(sourceLabel("/repo/src/components/Foo.tsx", 42, ROOT)).toBe(
      "src/components/Foo.tsx:42",
    );
  });

  // 사용자 홈 경로를 에이전트 프롬프트에 흘리지 않는다.
  it("저장소 밖 파일은 파일명만 남긴다", () => {
    expect(sourceLabel("/Users/someone/other/Bar.tsx", 7, ROOT)).toBe("Bar.tsx:7");
  });

  it("줄 번호가 없으면 경로만", () => {
    expect(sourceLabel("/repo/src/a.tsx", undefined, ROOT)).toBe("src/a.tsx");
  });

  it("파일명이 없으면 아무것도 만들지 않는다", () => {
    expect(sourceLabel(undefined, 1, ROOT)).toBeUndefined();
  });

  it("윈도우 구분자도 정규화한다", () => {
    expect(sourceLabel("C:\\repo\\src\\a.tsx", 3, "C:\\repo")).toBe("src/a.tsx:3");
  });
});

describe("shouldAnnotate", () => {
  it("소문자 DOM 태그에만 심는다", () => {
    expect(shouldAnnotate("div", [])).toBe(true);
    expect(shouldAnnotate("my-element", [])).toBe(true);
  });

  // 컴포넌트에 넣으면 DOM에 닿지 않는 채 prop으로 흘러가 계약만 오염된다.
  it("컴포넌트에는 심지 않는다", () => {
    expect(shouldAnnotate("Button", [])).toBe(false);
    expect(shouldAnnotate("Foo", [])).toBe(false);
  });

  it("손으로 적은 값이 이긴다", () => {
    expect(shouldAnnotate("div", [SOURCE_ATTRIBUTE])).toBe(false);
  });

  it("이름이 문자열이 아니면 심지 않는다", () => {
    expect(shouldAnnotate(undefined, [])).toBe(false);
  });
});

/** babel 없이 visitor를 직접 돌린다 — @babel/core는 직접 의존성이 아니다.
 *  실제 파이프라인에서의 동작은 headless DOM 검증으로 확인한다. */
function runVisitor(node, filename) {
  const types = {
    jsxAttribute: (name, value) => ({ type: "JSXAttribute", name, value }),
    jsxIdentifier: (name) => ({ type: "JSXIdentifier", name }),
    stringLiteral: (value) => ({ type: "StringLiteral", value }),
  };
  const plugin = dureSourcePlugin({ types }, { root: ROOT });
  plugin.visitor.JSXOpeningElement({ node }, { filename });
  return node.attributes;
}

const opening = (tag, attributes = [], line = 12) => ({
  name: { type: "JSXIdentifier", name: tag },
  attributes,
  loc: { start: { line } },
});

describe("dureSourcePlugin visitor", () => {
  it("DOM 태그 맨 앞에 소스 속성을 넣는다", () => {
    const attributes = runVisitor(opening("div"), "/repo/src/a.tsx");
    expect(attributes).toHaveLength(1);
    expect(attributes[0].name.name).toBe(SOURCE_ATTRIBUTE);
    expect(attributes[0].value.value).toBe("src/a.tsx:12");
  });

  // 뒤에 오는 spread나 명시적 속성이 이겨야 하므로 맨 앞이다.
  it("기존 속성보다 앞에 넣는다", () => {
    const existing = { type: "JSXAttribute", name: { name: "className" } };
    const attributes = runVisitor(opening("div", [existing]), "/repo/src/a.tsx");
    expect(attributes[0].name.name).toBe(SOURCE_ATTRIBUTE);
    expect(attributes[1]).toBe(existing);
  });

  it("컴포넌트는 건드리지 않는다", () => {
    expect(runVisitor(opening("Button"), "/repo/src/a.tsx")).toHaveLength(0);
  });

  it("JSXMemberExpression(<Foo.Bar>)은 건드리지 않는다", () => {
    const node = {
      name: { type: "JSXMemberExpression" },
      attributes: [],
      loc: { start: { line: 3 } },
    };
    expect(runVisitor(node, "/repo/src/a.tsx")).toHaveLength(0);
  });

  it("파일명을 모르면 넣지 않는다", () => {
    expect(runVisitor(opening("div"), undefined)).toHaveLength(0);
  });

  it("spread만 있는 요소에도 넣는다", () => {
    const spread = { type: "JSXSpreadAttribute" };
    const attributes = runVisitor(opening("div", [spread]), "/repo/src/a.tsx");
    expect(attributes).toHaveLength(2);
    expect(attributes[0].name.name).toBe(SOURCE_ATTRIBUTE);
  });
});
