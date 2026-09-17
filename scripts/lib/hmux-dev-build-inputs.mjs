export const HMUX_DEV_RUNTIME_INPUTS = Object.freeze([
  Object.freeze({ path: "hmux", recursive: true }),
  Object.freeze({ path: "crates/hebbian-process-sampler", recursive: true }),
  Object.freeze({ path: ".cargo/config.toml", recursive: false }),
  Object.freeze({ path: "rust-toolchain.toml", recursive: false }),
  Object.freeze({
    path: "scripts/build-hmux-product-runtime.sh",
    recursive: false,
  }),
  Object.freeze({
    path: "scripts/with-hmux-build-environment.sh",
    recursive: false,
  }),
  Object.freeze({
    path: "scripts/ensure-ghostty-vt-proof.mjs",
    recursive: false,
  }),
  Object.freeze({ path: "scripts/hmux-dev-build-id.mjs", recursive: false }),
  Object.freeze({
    path: "scripts/hmux-ghostty-zig-ar.sh",
    recursive: false,
  }),
  Object.freeze({
    path: "scripts/hmux-ghostty-zig-cc.sh",
    recursive: false,
  }),
  Object.freeze({ path: "scripts/install-hmux.sh", recursive: false }),
  Object.freeze({
    path: "scripts/lib/hmux-dev-build-inputs.mjs",
    recursive: false,
  }),
  Object.freeze({
    path: "scripts/prepare-hmux-dev-tools.sh",
    recursive: false,
  }),
  Object.freeze({ path: "scripts/stage-hmux-runtime.sh", recursive: false }),
  Object.freeze({
    path: "scripts/stage-hmux-remote-resources.sh",
    recursive: false,
  }),
  Object.freeze({ path: "scripts/package-hmux-prebuilt.sh", recursive: false }),
  Object.freeze({
    path: "scripts/verify-hmux-dev-activation.mjs",
    recursive: false,
  }),
  Object.freeze({
    path: "scripts/verify-hmux-product-runtime.sh",
    recursive: false,
  }),
]);
