#!/bin/bash
# 러너-로컬 도구 아카이브 캐시 — push마다 Lima/Syft/cargo-auditable/Rust dist를
# 수백 MB씩 재다운로드하던 것을 SHA256 주소화 캐시로 대체한다(2026-08-01 CI
# 감사 P1-4). 설계 원칙:
#   - 캐시는 다운로드만 대신한다. 각 워크플로 스텝의 기존 shasum 검증·추출·
#     버전 확인은 그대로 남는 보안 경계다(약화 금지).
#   - 히트 경로에서도 SHA256을 재검증한다 — 손상 엔트리는 삭제 후 재다운로드.
#   - 쓰기는 임시 파일 + 원자적 mv. 동시 실행은 같은 내용의 mv 경쟁이라 무해.
#   - 루트는 러너 영속 디렉터리(RUNNER_TOOL_CACHE) 아래 — cargo 세대 캐시
#     (_hebbian-ci-targets-v1)와 같은 "러너 상주" 관례. 보존 30일 초과 엔트리는
#     기회적으로 정리한다.
#
# 사용법: ci-tool-cache.sh <url> <sha256-hex> <output-path>
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: ci-tool-cache.sh <url> <sha256> <output>" >&2
  exit 2
fi
url=$1
sha=$2
out=$3

case "$sha" in
  *[!0-9a-f]*)
    echo "ci-tool-cache: invalid sha256" >&2; exit 2 ;;
esac
if [ "${#sha}" -ne 64 ]; then
  echo "ci-tool-cache: invalid sha256 length" >&2; exit 2
fi

root=${HEBBIAN_CI_TOOL_CACHE_ROOT:-${RUNNER_TOOL_CACHE:-$HOME/.cache}/hebbian-ci-tools-v1}
entry="$root/$sha"

# 테스트 픽스처만 file:// 허용 — 프로덕션 기본은 기존 스텝과 동일한 https 핀.
proto='=https'
if [ "${HEBBIAN_CI_TOOL_CACHE_ALLOW_FILE:-}" = "1" ]; then
  proto='=https,file'
fi

verify() {
  printf '%s  %s\n' "$sha" "$1" | shasum -a 256 -c - >/dev/null 2>&1
}

mkdir -p "$root"
if [ -f "$entry" ] && verify "$entry"; then
  echo "ci-tool-cache: hit $sha" >&2
else
  if [ -e "$entry" ]; then
    echo "ci-tool-cache: corrupt entry, refetching" >&2
    rm -f "$entry"
  fi
  tmp="$root/.download-$sha-$$"
  trap 'rm -f "$tmp"' EXIT
  curl --fail --location --proto "$proto" --tlsv1.2 --retry 3 \
    --connect-timeout 15 --max-time 600 \
    --output "$tmp" "$url"
  if ! verify "$tmp"; then
    echo "ci-tool-cache: downloaded artifact failed sha256 verification" >&2
    exit 1
  fi
  mv -f "$tmp" "$entry"
  trap - EXIT
  echo "ci-tool-cache: stored $sha" >&2
fi

touch "$entry"
cp "$entry" "$out"

# 기회적 보존 정리 — 실패해도 본 작업에 영향 없음.
find "$root" -maxdepth 1 -type f -mtime +30 ! -name ".download-*" -delete \
  2>/dev/null || true
