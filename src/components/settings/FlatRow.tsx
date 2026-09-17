/** 카드 안 플랫 행 (Figma 428-16688): 라벨 14px Medium + 설명 12px muted 왼쪽,
 *  컨트롤 오른쪽. 카드 하나에 행들을 담고 구분선으로 그룹을 나눈다.
 *  설정 창의 모든 페이지가 쓰는 기본 행 — SettingsDialog에서 추출(god-file 다이어트). */
export function FlatRow({
  title,
  desc,
  children,
}: {
  title: string;
  desc?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex w-full items-center gap-2">
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="text-sm leading-none font-medium text-foreground">{title}</span>
        {desc && <span className="text-xs text-muted-foreground">{desc}</span>}
      </div>
      {children && <div className="shrink-0">{children}</div>}
    </div>
  );
}
