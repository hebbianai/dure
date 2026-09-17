/** 에이전트 브랜드 로고 — onorca.dev에서 받은 원본을 그대로 번들한다.
 *  파일을 넣기만 하면 파일명(확장자 제외)이 곧 id로 등록된다. */
const assets = import.meta.glob("../../assets/agent-logos/*.{png,svg}", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

const byId = new Map<string, string>(
  Object.entries(assets).map(([path, url]) => [
    (path.split("/").pop() ?? "").replace(/\.(png|svg)$/, ""),
    url,
  ]),
);

/** 로고 파일 URL. 없는 id면 undefined — 호출부가 대체 글리프를 쓴다. */
export function agentLogoUrl(id?: string): string | undefined {
  return id ? byId.get(id) : undefined;
}

/** 번들된 로고 id 목록 (테스트·디버깅용). */
export function agentLogoIds(): string[] {
  return [...byId.keys()].sort();
}
