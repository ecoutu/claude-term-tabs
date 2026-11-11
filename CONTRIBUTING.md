# Contributing to claude-tabs

Bug reports, ideas and pull requests are welcome. Use the issue forms
([bug report](https://github.com/ecoutu/claude-tabs/issues/new?template=bug_report.yml),
[idea](https://github.com/ecoutu/claude-tabs/issues/new?template=idea.yml)).

## Set up

Requires Node.js 24. `ct` itself has no runtime dependencies; `npm ci` installs the commit hooks (husky and
commitlint).

```sh
npm ci
npm test
```

## Before you open a pull request

Run `npm test`, the check CI runs (the `pre-push` hook runs it too). Add or update tests with the change; they use
`node --test` (`tests/`), with `CT_NO_REAL_EXEC=1` so no test drives a real terminal. If you changed how ct talks to
a terminal, also run the README's [manual checks](README.md#manual-checks) in that terminal.

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
