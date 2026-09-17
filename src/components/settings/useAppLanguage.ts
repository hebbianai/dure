// 창(웹뷰) 단위 언어 초기화 훅 — i18n 모듈 전역(current)은 창마다 별개라서
// App뿐 아니라 bare-root 창(분리/소스 제어/diff)도 반드시 호출해야 한다.
// 안 하면 그 창은 소스 언어(한국어)로 굳는다. 반환값을 루트 key로 쓰면 언어
// 전환·사전 로드 완료 시 리마운트된다. en 외 언어 사전은 지연 로드라, 로드
// 전에는 한국어 폴백이 잠깐 보일 수 있고 로드 완료가 key를 바꿔 다시 그린다.
import { useEffect, useState } from "react";
import {
  ensureLangLoaded,
  isLangLoaded,
  resolveLang,
  setLang,
} from "@/lib/i18n";
import { syncNativeQuitConfirmationCopy } from "@/lib/workspace/window/nativeQuitConfirmation";
import { useStore } from "@/store";

export function useAppLanguage(): string {
  const language = useStore((s) => s.language);
  const [, setSystemLanguageRevision] = useState(0);
  useEffect(() => {
    if (language !== "system") return;
    const handleLanguageChange = () =>
      setSystemLanguageRevision((revision) => revision + 1);
    window.addEventListener("languagechange", handleLanguageChange);
    return () => window.removeEventListener("languagechange", handleLanguageChange);
  }, [language]);
  const lang = resolveLang(language);
  const [loadedRevision, setLoadedRevision] = useState(0);
  useEffect(() => {
    if (isLangLoaded(lang)) return;
    let cancelled = false;
    void ensureLangLoaded(lang).then(() => {
      if (!cancelled) setLoadedRevision((revision) => revision + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [lang]);
  setLang(lang);
  useEffect(() => {
    if (!isLangLoaded(lang)) return;
    void syncNativeQuitConfirmationCopy().catch((error) => {
      console.warn(
        "[app-quit] Could not update native confirmation language",
        error,
      );
    });
  }, [lang, loadedRevision]);
  return `${lang}:${isLangLoaded(lang) ? "ready" : `loading${loadedRevision}`}`;
}
