# Dure product media

Follow Dure's [contribution guide](https://github.com/hebbianai/dure/blob/main/CONTRIBUTING.md)
when proposing public product media. The runner owns scenarios, options and
evidence; captures require the review and sanitization described below.

```sh
pnpm media:capture:list
pnpm media:capture -- --help
node tools/media-capture/storyboard.mjs --list
node tools/media-capture/review-storyboard.mjs --help
```

| Responsibility | Source |
| --- | --- |
| Scenario data and timelines | [scenarios.mjs](scenarios.mjs) |
| Browser capture and argument handling | [capture.mjs](capture.mjs), [cli.mjs](cli.mjs) |
| Real Tauri window capture | [native.mjs](native.mjs), [native/run.sh](native/run.sh) |
| Proof requirements | [capture-proof.mjs](runtime/capture-proof.mjs) |
| Composition schema and source selection | [schema.mjs](compositor/schema.mjs), [source-selection.mjs](compositor/source-selection.mjs) |
| Render review and baseline acceptance | [review-render.mjs](compositor/review-render.mjs), [review-baseline.mjs](compositor/review-baseline.mjs) |

The isolated [renderer package](compositor/remotion/package.json) owns its
runtime/dependency requirements; install it through its nested lockfile. Check
licensing for the intended team and distribution before using it.

Keep captures and review candidates under ignored `output/playwright/` paths.
Only visually reviewed, sanitized artifacts with matching current evidence may
cross into public directories. A passing capture does not approve a baseline,
certify a live lifecycle, or publish a site.
