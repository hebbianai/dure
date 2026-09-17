// Spaces pane의 휘발 UI 상태(검색어) — 컴포넌트 useState였을 때는 사이드바
// 탭을 옮기면 SpacesPane이 통째로 unmount되며 전부 증발했다(감사 마찰 #12).
// 모듈 스토어로 올려 탭 왕복에도 살아남되, persist는 하지 않는다 — 앱
// 재시작까지 살릴 상태는 아니고 재시작이 곧 초기화가 자연스럽다.
import { create } from "zustand";

interface SpacesPaneUiState {
	query: string;
	setQuery: (query: string) => void;
}

export const useSpacesPaneUi = create<SpacesPaneUiState>((set) => ({
	query: "",
	setQuery: (query) => set({ query }),
}));
