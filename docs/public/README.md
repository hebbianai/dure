# Maintain the Dure documentation

This directory is the complete source root for
[docs.dureai.dev](https://docs.dureai.dev/en/introduction). Mintlify publishes
`/docs/public` from the `main` branch of the public
[hebbianai/dure](https://github.com/hebbianai/dure) repository. Files outside
this directory must remain outside that publishing boundary.

## Edit the user journey

The four locale trees share one structure in `docs.json`:

1. Start here: introduction, installation and the first Command-N task.
2. Work on tasks: independent worktrees, GitHub task starts and review.
3. Workspace: Spaces, panes, terminals, files and everyday settings.
4. Coding agents: providers, accounts, sessions and recovery.
5. Connections: SSH projects, VM environments and app plugins.
6. Automation: CLI runs, schedules, messages and decisions.
7. Help: privacy and usage data, current limits and troubleshooting.

Write the English version first, then synchronize `cn`, `ko` and `jp` in the
same change. `cn` and `jp` are Mintlify's identifiers for Simplified Chinese
and Japanese. These four documentation languages are separate from the app's
seven display languages. Every published MDX page must appear in `docs.json`;
unlisted pages can still have public URLs. Preserve existing routes when
reorganizing navigation.

The hosted HTML still declared `cn` and `jp` after a verified deployment using
supported `zh-Hans` and `ja` configuration aliases on 2026-09-17. Changing
those values alone did not correct the HTML language tags and broke the existing
installation-route checker. Keep the route-compatible configuration until a
hosted language-tag correction is verified; do not hide the remaining HTML issue
with a client-side patch or weaken the download checks.

Lead with the user's task, result and next decision. Explain sessions and
worktrees where they help the workflow. Code and behavioral tests own current
implementation; release metadata owns the download, signing and update claims.
Check both before changing user instructions. Features implemented on `main`
may be documented for the next release, but an implementation capture is not
proof of a published binary or a guarantee of lifecycle behavior.

## Keep release guidance consistent

The installation pages own the download, security and update steps. Other pages
should link there instead of duplicating version-specific facts. All four install
pages, the navbar and footer use `https://www.dureai.dev/download/mac/`, the same
current-beta download as the homepage. The release publisher owns version selection
through the public beta channel; advancing it needs no documentation edit.
Keep release-specific features, signing and limitations in the public release notes.
`releases/latest` does not necessarily select the current prerelease beta.
Checking for an update, downloading it and installing it are distinct user actions.

## Validate and preview

From this directory, run the pinned Mintlify validator and link checker:

```sh
pnpm dlx mint@4.2.762 validate
pnpm dlx mint@4.2.762 broken-links
```

For a local preview, use repository storage admission and an available port:

```sh
node ../../scripts/run-with-build-storage.mjs frontend -- corepack pnpm dlx mint@4.2.762 dev --port 3077 --no-open
```

Review desktop and mobile pages in light and dark mode, including navigation,
new pages, locale glyphs, tables, callouts and code controls. Verify product
figures and their localized descriptions when moving them between pages. From
the repository root, run `node scripts/check-docs-product-figures.mjs <preview-url>`
for figure containment, provider tabs and localized accessibility checks. Upgrade
the pinned Mintlify version as a separate reviewed tooling change rather than
implicitly using latest.

Land through the repository's reviewed fast-forward workflow. After deployment,
check the changed public pages and run `pnpm docs:check-downloads` from the
repository root. That check verifies the published installation Markdown and
`llms-full.txt`, as well as the shared download destination. A local validation
pass alone is not proof of public delivery.

## Keep media and brand assets reviewable

Use `ProductFigure` from `/snippets/app-capture.jsx` inside a Mintlify `Frame`.
It displays the shipped React DOM, CSS, fonts and provider glyphs captured with
safe fixture data. Each scene has an actual light and dark app rendering. The
sandboxed, inert frame keeps the original 1344 × 822 viewport. The template crops
and uniformly scales the relevant region. Scenes alternate between a complete
shadowed window, an enlarged crop extending to the edge, and a focused detail
whose right and lower edges fade into the page. Keep the instructional subject
clear of the fade. The figure contains no app runtime and cannot start an agent.
Its only embedded script restores captured scroll positions once the viewport
is visible and fonts load.

Regenerate with the repository's pinned Node version:

```sh
node scripts/run-with-build-storage.mjs frontend -- node tools/media-capture/docs-product-figures.mjs
```

The exporter writes candidates, readable HTML, source/export PNG pairs and source
receipts under `output/playwright/docs-product-figures/`. Compare every pair and
review visible content before copying its generated `product-figure.jsx` to
`snippets/app-capture.jsx`. The component template lives beside the exporter;
`--bundle` rebuilds the component from the saved captures after template changes.
The generated snippet packages deduplicated CSS and per-scene DOM with gzip;
modern browsers unpack them locally without fetching an app bundle or UI assets.
Do not hand-draw replacement chrome or edit the generated capture payloads.
The fixture codec preserves ANSI foreground/background colors through the real
structured terminal renderer; do not recolor captured text with a CSS overlay.

The twelve decorative wallpapers in `images/gradients/` are exact Figma MCP
renders of BRIX Templates' [Gradient Backgrounds](https://www.figma.com/design/OurOyJ2hBqhGzVlGoylekU/Gradient-Backgrounds---Visual-Assets-%7C-BRIX-Templates--Community-?node-id=2393-1484).
Files `brix-01.png` through `brix-12.png` follow the original numbered designs.
These decorative backgrounds are raster artwork; all product UI remains HTML.

Pass the scene, locale and localized description, and keep the caption consistent
with the captured state. Task output is illustrative fixture data, not evidence
of a live run. The capture uses the real browser UI with the media harness's
macOS window controls, not a recording of a native desktop. Historical product
captures in `images/` and `videos/` remain excluded by `.mintignore`; only the
explicit gradient directory is published. Raw captures and private
evidence stay outside the publishing tree.

Configure the neutral palette, vector logos, fonts and appearance in `docs.json`.
Keep `style.css` overrides limited to typography, insets, focus and the documented
action hook, and figure styles scoped to `.dure-figure`. Mintlify owns the Maple
reading layout.

The font assets reuse `@fontsource-variable/geist@5.3.0`,
`@fontsource-variable/inter@5.3.0`, `@fontsource-variable/geist-mono@5.3.0` and
`pretendard@1.3.9` from the website. Retain their licenses in `fonts/licenses/`.
Pretendard's upstream Unicode subsets use absolute
`/fonts/pretendard/woff2-dynamic-subset/` URLs because Mintlify includes CSS
globally. Do not add another import or restore route-relative URLs.
The logo lockup comes from `mobile/src/assets/logo-dure-wordmark.svg`;
the favicon uses the website mark.

## Preserve the public boundary

Keep user instructions free of private source links, internal issue evidence,
source-build instructions and speculative roadmap, pricing or license claims.
Public release artifacts and the curated public repository do not make the
private development tree public. Track plans and drafts in GitHub Issues.
Navigation visibility alone does not prevent direct access to a published file.

The Mintlify dashboard's Git settings select `hebbianai/dure`, branch `main`
and the `docs/public` subdirectory. When changing that source, preserve the
branch and path until the replacement source is reviewed.
Grant the GitHub App access only to the required repository. Verify the assigned
preview URL and domain ownership before changing public links or DNS.
