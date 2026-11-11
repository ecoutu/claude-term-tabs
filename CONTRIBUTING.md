# Contributing to claude-term-tabs

Bug reports, ideas and pull requests are welcome. Use the issue forms
([bug report](https://github.com/ecoutu/claude-term-tabs/issues/new?template=bug_report.yml),
[idea](https://github.com/ecoutu/claude-term-tabs/issues/new?template=idea.yml)).

## Set up

Requires Node.js 24. `ctt` itself has no runtime dependencies; `npm ci` installs the commit hooks (husky and
commitlint).

```sh
npm ci
npm run check   # type-check
npm test
```

The package ships JavaScript built into `dist/` (`npm run build`, run for you by `npm pack` and `npm publish`); a
checkout runs the TypeScript in `src/` directly. `npm run test:package` packs, installs and runs the package; it is
kept out of `npm test` because it takes seconds.

Releases publish to npm with trusted publishing: `release.yml` trades a GitHub OIDC token for the publish, so no npm
token is stored. npm sets up trusted publishing only for a package that already exists, so the very first publish was
by hand: `npm publish --tag bootstrap` of version `0.0.0-bootstrap` from a fresh clone, then
`npm trust github claude-term-tabs --repo ecoutu/claude-term-tabs --file release.yml --allow-publish`. If the package is ever
recreated, do that again before merging anything that releases.

## Before you open a pull request

Run `npm run check` (type-check), `npm test` and `npm run test:package`, the checks CI runs (the `pre-push` hook runs
them too). Add or update tests with the change; they use `node --test` (`tests/`), with `CTT_NO_REAL_EXEC=1` so no
test drives a real terminal.
If you changed how ctt talks to a terminal, also run the README's [manual checks](README.md#manual-checks) in that
terminal.

Never commit a real transcript, prompt or token into `tests/fixtures/`. CI scans every branch with gitleaks
(`.gitleaks.toml`).

## Commits and pull requests

- Commits follow [Conventional Commits](https://www.conventionalcommits.org/): `fix(pause): keep waiting on a
  session that is still busy`. A commit hook runs commitlint. Use `feat` for something users see that is new, `fix`
  for a user-visible fix, and `refactor`, `test`, `docs`, `build`, `ci` or `chore` for the rest. The types decide the
  version and the release notes, so pick them with care.
- The pull request title is a Conventional Commit too (the `pr-title` check enforces it): a squash merge uses it as the
  commit title.
- History stays linear. Rebase on `main` (`git fetch && git rebase origin/main`); never merge `main` into your branch.
- Keep a pull request to one change, so its type describes all of it.
