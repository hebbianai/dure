import { describe, expect, it } from "vitest";
import { langIdFor, languageLabel } from "@/lib/editor/codeLang";

describe("langIdFor", () => {
  it("주요 확장자에 언어를 붙인다", () => {
    expect(langIdFor("a.ts")).toBe("typescript");
    expect(langIdFor("a.tsx")).toBe("tsx");
    expect(langIdFor("a.rs")).toBe("rust");
    expect(langIdFor("a.py")).toBe("python");
    expect(langIdFor("a.sh")).toBe("shell");
    expect(langIdFor("a.md")).toBe("markdown");
  });

  it("대소문자를 가리지 않는다", () => {
    expect(langIdFor("README.MD")).toBe("markdown");
  });

  it("경로가 붙어 있어도 파일 이름만 본다", () => {
    expect(langIdFor("/repo/src/App.tsx")).toBe("tsx");
  });

  it("확장자 없는 잘 알려진 파일도 인식한다", () => {
    expect(langIdFor("Dockerfile")).toBe("dockerfile");
    expect(langIdFor("Makefile")).toBe("properties");
  });

  it("모르는 형식은 null (플레인 텍스트로 표시)", () => {
    expect(langIdFor("notes.xyz")).toBeNull();
    expect(langIdFor("LICENSE")).toBeNull();
  });
});

describe("languageLabel", () => {
  it("확장자를 라벨로 쓴다", () => {
    expect(languageLabel("src/App.tsx")).toBe("tsx");
  });

  it("모르는 형식은 text", () => {
    expect(languageLabel("notes.xyz")).toBe("text");
    expect(languageLabel("LICENSE")).toBe("text");
  });
});
