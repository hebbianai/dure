# Contributing to Dure

Dure is maintained by Hebbian AI. We welcome clear bug reports, focused proposals,
documentation improvements and translations. Please follow our
[Code of Conduct](CODE_OF_CONDUCT.md).

## What you can contribute today

This repository currently contains Dure's public README files, product media and
community files. Application source publication under [MIT](LICENSE) is in
preparation; the application cannot yet be built from this repository.

You can report problems with the distributed app, suggest improvements, and open
pull requests for the files available here. Source build instructions and the
matching build/test checks will accompany the application source release.

## Issues and proposals

Search [existing issues](https://github.com/hebbianai/dure/issues) before opening
a report. Use the [issue forms](https://github.com/hebbianai/dure/issues/new/choose)
to include the app version, environment, reproduction steps, and expected and
actual behavior. For a substantial change, discuss the problem in an issue
before investing in an implementation.

Remove credentials, private conversations, customer data and identifying file
paths from screenshots and logs. Report suspected vulnerabilities through the
private channel in [SECURITY.md](SECURITY.md).

## Your first pull request

1. Fork this repository and clone your fork.
2. Create a topic branch from the current `main`, for example
   `git switch -c docs/clarify-installation`.
3. Make one focused change. Preserve existing copyright and third-party notices.
4. Preview changed Markdown, images and links. Run `git diff --check` and describe
   the checks you actually performed.
5. Push your branch to your fork and open a pull request against
   `hebbianai/dure:main`. Explain the problem, the change, and how you checked it;
   link a related issue when one exists.
6. Address review feedback and wait for the required checks and maintainer review.

English is the canonical documentation language. The English [README](README.md)
lives at the root; the six translations live in [docs/readme/](docs/readme/).
Keep facts consistent across all seven languages when changing shared product
information. If you cannot update a translation confidently, call that out in the
pull request so a maintainer can coordinate it. Translation corrections for one
language are also welcome. Do not claim availability for unreleased source,
platforms or features.

## Checks and review

The `Public repository checks` job validates whitespace in the proposed diff and
local documentation links. These checks cover the current public repository;
they do not build or test the application. To run the link check locally with
[lychee](https://github.com/lycheeverse/lychee), use:

```sh
lychee --offline --include-fragments --no-progress '*.md' 'docs/readme/*.md' '.github/**/*.md'
```

The workflow pins its tool versions in
[public-repository.yml](.github/workflows/public-repository.yml).

Contributors submit changes to `main` through pull requests. Merging requires
passing checks, an up-to-date branch, one approving review, code-owner approval
where applicable, and resolved review conversations. New changes dismiss stale
approvals; the latest push needs approval from someone other than its pusher.
Maintainers squash approved pull requests; the ruleset blocks force pushes and
deletion of `main`.

The repository administrator `komojini` has an explicit always-on bypass for this
ruleset, including direct pushes and merges without the required review or checks.
Other contributors and administrators remain subject to the rules above.

Contributors remain responsible for everything they submit, including work
prepared with AI tools. Check the diff, verify claims, and describe any testing
limits. Maintainers may request a smaller scope or further evidence before
accepting a change.

## Licensing

Submit only work you have the right to contribute under the project's
[MIT license](LICENSE). Preserve third-party licenses and identify the source and
license of any material you add.
