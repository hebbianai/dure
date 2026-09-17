# Generated Hmux sidecars

`pnpm dev`, `pnpm build`, and the `hmux:runtime:stage:*` scripts build the
provider-neutral runtime from `../hmux` and stage it here using Tauri's required
`hmux-runtime-<target-triple>` naming. Generated binaries are intentionally
ignored; the Rust source in this repository is the distributable source of
truth.
