# Generated remote Hmux resources

`pnpm app:dev` and `pnpm build` stage the two supported static Linux Hmux trees
here. Apple silicon builds also stage an `aarch64-apple-darwin` tree for macOS
SSH hosts; no other platform can produce it. The generated target directories
are ignored and are bundled into Dure; the Hmux source and installer remain the
source of truth.
