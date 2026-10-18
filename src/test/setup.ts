/** 스토어 persist가 localStorage를 직접 만진다 — node 환경(vitest)용 최소 스텁.
 *  setupFiles라 테스트 파일이 @/store를 import하기 전에 깔린다. */
const persisted = new Map<string, string>();

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => persisted.get(key) ?? null,
    setItem: (key: string, value: string) => {
      persisted.set(key, value);
    },
    removeItem: (key: string) => {
      persisted.delete(key);
    },
    clear: () => persisted.clear(),
  },
});

// Production WebViews serialize durable writers with the origin-wide Web
// Locks API. Vitest's node/jsdom environments do not implement it, so provide
// the same per-name exclusive ordering at the browser boundary.
const lockTails = new Map<string, Promise<void>>();
const locks = {
	request: <T>(
		name: string,
		_options: LockOptions,
		callback: (lock: Lock | null) => Promise<T> | T,
	): Promise<T> => {
		const predecessor = lockTails.get(name) ?? Promise.resolve();
		const pending = predecessor.then(() =>
			callback({ name, mode: "exclusive" } as Lock),
		);
		lockTails.set(
			name,
			pending.then(
				() => undefined,
				() => undefined,
			),
		);
		return pending;
	},
};
if (!("navigator" in globalThis)) {
	Object.defineProperty(globalThis, "navigator", {
		configurable: true,
		value: {},
	});
}
Object.defineProperty(globalThis.navigator, "locks", {
	configurable: true,
	value: locks,
});

// jsdom 환경(.test.tsx)용 브라우저 API 폴리필 — radix scroll-area 등이 요구한다.
// node 환경 테스트는 window가 없어 이 블록을 건너뛴다.
if (typeof window !== "undefined") {
  if (!("ResizeObserver" in window)) {
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    (window as unknown as { ResizeObserver: unknown }).ResizeObserver =
      ResizeObserverStub;
  }
  if (!window.matchMedia) {
    window.matchMedia = (query: string) =>
      ({
        matches: false,
        media: query,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        onchange: null,
        dispatchEvent: () => false,
      }) as MediaQueryList;
  }
}

// 테스트 기본 언어는 모듈 기본값 ko다. legacy 한국어-문장 키는 통과 반환이라
// 사전이 필요 없지만 semantic ID 키는 ko 카탈로그가 있어야 같은 한국어를
// 돌려준다. 앱은 useAppLanguage가 로드하고, 테스트는 여기서 미리 로드해
// 두 키 클래스의 렌더 결과를 동일하게 유지한다.
import { ensureLangLoaded } from "@/lib/i18n";

await ensureLangLoaded("ko");
