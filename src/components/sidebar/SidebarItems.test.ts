import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { describe, expect, it } from "vitest";
import { sidebarLabelTone, sidebarSectionLabelTone } from "@/components/sidebar/SidebarItems";

// 폴더 정리(2026-08-01) 후 헤더 소유 파일이 다른 클러스터에 있다 —
// components 루트 기준 상대 경로로 읽는다.
const source = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), "utf8");

describe("sidebar label tones", () => {
  it("섹션 헤더는 foreground/70 — 시안 2070:32041의 secondary-foreground @ 70%", () => {
    expect(sidebarSectionLabelTone()).toContain("text-sidebar-foreground/70");
  });

  it("섹션 헤더가 항목 라벨보다 진하다 — 같은 회색이면 위계가 사라진다", () => {
    // 항목 라벨은 muted-foreground, 섹션 헤더는 그보다 진한 foreground/70.
    expect(sidebarLabelTone()).toContain("text-muted-foreground");
    expect(sidebarSectionLabelTone()).not.toContain("text-muted-foreground");
  });

  it("호버 규칙은 둘이 같다 — 행의 group/label이 판정한다", () => {
    expect(sidebarSectionLabelTone()).toContain("group-hover/label:text-sidebar-foreground");
    expect(sidebarLabelTone()).toContain("group-hover/label:text-sidebar-foreground");
  });

  it("선택된 항목 라벨은 호버 없이도 밝다", () => {
    expect(sidebarLabelTone(true)).toContain("text-sidebar-foreground");
    expect(sidebarLabelTone(true)).not.toContain("text-muted-foreground");
  });

  /** 헤더가 여러 컴포넌트에 흩어져 있어 한 번 놓쳤다: SectionHeaderRow만 고쳤더니
   *  "스페이스"(SpacesPane의 h2)는 그대로여서 헤더 둘의 색이 갈렸다(사용자 제보).
   *  같은 계층은 같은 톤을 쓴다는 것을 여기서 묶어 둔다. */
  it("사이드바의 섹션·그룹 라벨은 전부 섹션 톤을 쓴다", () => {
    // 데스크탑 그룹 라벨도 같은 Sidebar/Label(2386:41114)이다 — 시안에서 한
    // 컴포넌트인 것이 코드에서 두 톤으로 갈리지 않게 여기서 함께 묶는다.
    // SpacesPane은 제목·섹션 라벨을 전부 SectionHeaderRow(이 파일의 톤 소유자)
    // 로 그리게 되어(2026-09-03) 손으로 짠 라벨이 없다 — 목록에서 뺀다.
    for (const file of ["spaces/SpacesGroupHeader.tsx"]) {
      expect(source(file)).toContain("sidebarSectionLabelTone()");
      expect(source(file)).not.toContain("sidebarLabelTone()");
    }
  });

  /** A group label rendered through SidebarGroupLabel inherits the tone from
   *  this file, so asserting the tone's name in the caller would only assert
   *  that the label is still hand-rolled. These callers are checked for the
   *  component instead — same invariant, stated where it now lives. */
  it("그룹 라벨을 쓰는 화면은 공용 SidebarGroupLabel을 통한다", () => {
    for (const file of [
      "sidebar/RecentFileOpensSection.tsx",
      "files/FilesPane.tsx",
    ]) {
      expect(source(file)).toContain("<SidebarGroupLabel");
      expect(source(file)).not.toContain("sidebarLabelTone()");
    }
  });
});
