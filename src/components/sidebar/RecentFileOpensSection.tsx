import { OverflowRevealText } from "@/components/ui/overflow-reveal-text";
// 파일 사이드 패널의 "최근 파일" — pane 포커스와 무관하게 항상 보인다
// (사용자 요청 2026-08-01). 기록 원천은 lib/files/recentFileOpensStore
// (뷰어 열기 관문에서 기록), 클릭하면 활성 데스크탑에 다시 연다.
//
// Figma 2391:46564 + 2391:46828 "Search/File/recent": 아이콘 없는 Sidebar/Label
// 아래에 두 줄짜리 행이 2px 간격으로 쌓인다. 윗줄은 12px 파일 글리프(종류와
// 무관하게 하나) + 이름(13px), 아랫줄은 글리프 폭만큼(18px) 들여쓴 경로(13px,
// 70%)다. 경로를 이름과 같은 크기로 두는 것이 시안이다 — 한 단 줄이면 두 줄짜리
// 행이 제목+캡션처럼 읽혀서, 둘 다 "어느 파일인가"를 말하는 한 덩어리라는 게
// 흐려진다.
import { openFileViewer } from "@/lib/files/fileViewerPane";
import { t } from "@/lib/i18n";
import { useRecentFileOpens } from "@/lib/files/recentFileOpensStore";
import { recentFileLabel } from "@/lib/files/recentFilePathLabel";
import { SidebarGroupLabel } from "@/components/sidebar/SidebarItems";
import { FileGlyph } from "@/components/sidebar/FileGlyph";
import { useStore } from "@/store";

/** How many recent files the sidebar lists. Five, not eight: this block and the
 *  file tree share one scroll column, and eight two-line entries took 432px of
 *  a 980px pane — the tree opened on eleven rows, so the file tab showed barely
 *  any files. Five leaves the tree sixteen.
 *
 *  The row height is deliberately NOT the lever here. Every sidebar tab keeps
 *  one rhythm (8px padding: 32px one-line rows, 53px two-line entries), because
 *  the tabs take turns in the same 300px column — a density that changes when
 *  you switch tabs reads as the panel shifting under you, not as two regions.
 *  Side-by-side panels can differ; sequential ones cannot. So when this pane
 *  runs out of room, the fix is how many entries it lists, never how tall they
 *  are (owner decision 2026-09-08). */
const VISIBLE_CAP = 5;

export function RecentFileOpensSection() {
	const entries = useRecentFileOpens((state) => state.entries);
	if (entries.length === 0) return null;
	return (
		// 접기가 사라진 뒤로는 이 블록이 줄어들 수 있어야 한다. shrink-0이면 최근
		// 목록이 길 때 아래 트리(flex-1)를 0으로 밀어내는데, 이제 되찾을 조작이
		// 없다. 좁아지면 스스로 줄고 안쪽 목록이 스크롤을 맡는다.
		<div className="flex flex-col pb-2">
			{/* 2391:46564 "Sidebar/Label" — 아이콘 없는 글자 한 줄이다. 셰브런으로
			    접는 기능이 있었는데 시안에 그 기호가 없어서 걷었다(사용자 지시
			    2026-08-12, “정확하게 똑같이”). 셰브런만 지우고 클릭은 남기면 보이지
			    않는 조작이 되므로 접기 자체를 함께 뺐다 — 목록은 아래 자체 스크롤로
			    묶여 있어 길어져도 트리를 밀어내지 않는다. */}
			{/* group/label을 달지 않는다 — 누를 수 없는 줄이 호버에 밝아지면
			    없는 조작을 약속하게 된다. */}
			<SidebarGroupLabel className="mt-2">{t("sidebar.recentFiles.title")}</SidebarGroupLabel>
			{/* No scroller of its own any more: this block now sits inside the file
			    tree's scroll area, so a long recent list scrolls with the tree
			    instead of pushing it to zero height. VISIBLE_CAP keeps it from
			    filling the first screen on its own. The side inset comes from that
			    scroll viewport, so this block adds none of its own. */}
			<div className="flex flex-col">
					{entries.slice(0, VISIBLE_CAP).map((entry) => {
						const { name, directory } = recentFileLabel(entry.path);
						return (
							<button
								key={`${entry.source}:${entry.hostId ?? ""}:${entry.path}`}
								type="button"
								className="flex w-full flex-col gap-1.5 rounded-md p-2 text-left hover:bg-glass-tint-hover"
								onClick={() =>
									openFileViewer(useStore.getState().activeDesktopId, {
										path: entry.path,
										source: entry.source,
										...(entry.hostId ? { hostId: entry.hostId } : {}),
									})
								}
							>
								<span className="flex w-full min-w-0 items-center gap-2">
									<FileGlyph />
									<OverflowRevealText text={name}
										className="min-w-0 text-xs leading-none text-sidebar-foreground" />
								</span>
								{directory && (
									// 24px — the comp's own value (3404:86381). Two pixels wider
									// than this row's glyph + gap (14 + 8), because the comp draws
									// one of the three entries with a 16px glyph.
									<span className="flex w-full min-w-0 items-center pl-[24px]">
										<OverflowRevealText text={directory}
											className="min-w-0 flex-1 text-meta leading-none text-sidebar-foreground/70" />
									</span>
								)}
							</button>
						);
				})}
			</div>
		</div>
	);
}
