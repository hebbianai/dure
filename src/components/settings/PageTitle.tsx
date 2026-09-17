/**
 * 설정 페이지의 상단 제목과 설명 (디자인의 Section Title).
 *
 * `SettingsDialog.tsx`에서 빼냈다. 페이지를 별도 파일로 옮기려면 이 프리미티브가
 * 양쪽에서 보여야 하는데, 페이지가 `SettingsDialog`에서 가져오고 `SettingsDialog`가
 * 그 페이지를 가져오면 순환이 된다.
 */

export function PageTitle({ title, desc }: { title: string; desc?: string }) {
  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-xl leading-none font-medium text-foreground">{title}</h2>
      {desc && <p className="text-sm text-muted-foreground">{desc}</p>}
    </div>
  );
}
