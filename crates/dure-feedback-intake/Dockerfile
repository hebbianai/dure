# Image for the feedback intake HTTP service.
#
# The process keeps no state on disk of its own — the rate limiter's
# counters live only in process memory, and every durable record (issues,
# uploaded assets) lives in GitHub. So there are no volumes and no config
# files to mount here.

# **Pin the Debian release on both stages, not just the Rust version.** The
# unsuffixed `rust:1.97-slim` tag follows Debian's current stable, so it moved
# to trixie and started producing binaries that need GLIBC_2.38. Against the
# bookworm runtime below (glibc 2.36) that binary cannot start at all: the
# 2026-09-15 deploy looped `version 'GLIBC_2.38' not found` until the machine
# hit its restart limit. Naming the suite on both ends makes the two glibcs
# move together or not at all.
FROM rust:1.97-slim-bookworm AS build
WORKDIR /src
# Unlike the relay, this crate has no dependency on
# `crates/dure-hub-protocol` (or any other workspace crate), so only its
# own directory needs to be copied. Copying just this directory — not the
# whole repository — means an unrelated file changing elsewhere never
# invalidates this layer's cache.
COPY crates/dure-feedback-intake crates/dure-feedback-intake
RUN cargo build --release --locked --manifest-path crates/dure-feedback-intake/Cargo.toml

# No toolchain in the final image. This process is reachable from the
# internet, so the less that is present inside it, the better.
FROM debian:bookworm-slim
# **Root certificates are not optional here, unlike in the relay.** This
# service dials GitHub and Telegram over TLS, and the slim image ships no
# trust store, so `reqwest::Client::new()` panics with "No CA certificates
# were loaded from the system" before `main` reaches its own checks — the
# 2026-09-15 deploy crash-looped on exactly that. The relay never makes an
# outbound TLS call, which is why its image can do without this.
RUN apt-get update \
 && apt-get install --yes --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# Do not run as root. This process only ever needs the one socket it binds.
RUN useradd --system --no-create-home --shell /usr/sbin/nologin feedback-intake
COPY --from=build /src/crates/dure-feedback-intake/target/release/dure-feedback-intake /usr/local/bin/dure-feedback-intake
USER feedback-intake

# `main.rs` binds 0.0.0.0:8080 unconditionally — there is no environment
# override for host or port, so none is set here either.
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/dure-feedback-intake"]
