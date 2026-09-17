# 릴레이 하나를 담는 이미지.
#
# 이 프로세스는 상태를 디스크에 남기지 않는다 — 등록은 control 연결이 끊기면
# 사라지고, 재시작이 정상 동작의 일부다. 그래서 볼륨도 설정 파일도 없다.

FROM rust:1.97-slim AS build
WORKDIR /src
# 워크스페이스가 아니라 두 크레이트만 복사한다. 저장소 전체를 넣으면 무관한
# 파일 하나가 바뀔 때마다 캐시가 깨진다.
COPY crates/dure-hub-protocol crates/dure-hub-protocol
COPY crates/dure-relay crates/dure-relay
RUN cargo build --release --locked --manifest-path crates/dure-relay/Cargo.toml

# 최종 이미지에 툴체인을 남기지 않는다. 인터넷에 열린 프로세스라, 안에 있는
# 것이 적을수록 좋다.
FROM debian:bookworm-slim
# 루트로 돌리지 않는다. 이 프로세스에 필요한 권한은 소켓 하나뿐이다.
RUN useradd --system --no-create-home --shell /usr/sbin/nologin relay
COPY --from=build /src/crates/dure-relay/target/release/dure-relay /usr/local/bin/dure-relay
USER relay

# 기본값은 모든 인터페이스. 이 프로세스의 존재 이유가 바깥에서 오는 연결을 받는
# 것이라, 루프백 기본값은 조용히 아무도 못 붙는 배포를 만든다.
ENV DURE_RELAY_ADDRESS=0.0.0.0
ENV DURE_RELAY_PORT=8787
EXPOSE 8787

ENTRYPOINT ["/usr/local/bin/dure-relay"]
