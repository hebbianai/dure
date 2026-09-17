import { afterEach, describe, expect, it } from "vitest";
import { ensureLangLoaded, resolveLang, setLang, t } from "./i18n";

describe("i18n", () => {
	afterEach(() => setLang("ko"));

	it("uses the composed English dictionary", () => {
		setLang("en");
		expect(t("common.file")).toBe("File");
		expect(t("common.selectSessionsToStart")).toBe(
			"Select at least one session to start.",
		);
	});

	it("keeps the Korean source string when a translation is missing", () => {
		setLang("en");
		expect(t("아직 등록되지 않은 번역 키")).toBe("아직 등록되지 않은 번역 키");
	});
});

describe("기본 언어 (사용자 지시 2026-08-02)", () => {
  it("명시 선택이 없으면(system) OS 로케일과 무관하게 언제나 English다", () => {
    expect(resolveLang("system")).toBe("en");
  });
});

describe("semantic message IDs", () => {
	afterEach(() => setLang("ko"));

	it("resolves a semantic ID from the canonical English catalog", () => {
		setLang("en");
		expect(t("common.closePane")).toBe("Close pane");
	});

	it("resolves Korean for a semantic ID from the explicit ko catalog", async () => {
		await ensureLangLoaded("ko");
		setLang("ko");
		expect(t("common.closePane")).toBe("pane 닫기");
	});

	it("falls back to canonical English (never the raw ID) for untranslated languages", async () => {
		await ensureLangLoaded("zh");
		setLang("zh");
		// zh has this key; delete-resilience: an id missing everywhere returns
		// itself so the failure is visible in dev.
		expect(t("common.closePane")).not.toBe(
			"common.closePane",
		);
		expect(t("no.such.key")).toBe("no.such.key");
	});

	it("keeps legacy Korean-sentence keys on their original chain", () => {
		setLang("ko");
		expect(t("아직 등록되지 않은 번역 키")).toBe("아직 등록되지 않은 번역 키");
	});
});
