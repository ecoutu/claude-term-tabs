# [2.0.0](https://github.com/ecoutu/claude-term-tabs/compare/v1.3.0...v2.0.0) (2026-11-11)


* feat(cli)!: rename to claude-term-tabs, with ctt as the short command ([e9459a2](https://github.com/ecoutu/claude-term-tabs/commit/e9459a29d40cc63b55b6420ec51498f85cab404a))


### Bug Fixes

* **cli:** write all of the output when it goes to a pipe ([14a6bf0](https://github.com/ecoutu/claude-term-tabs/commit/14a6bf0d813805f038327fcf9276d10d582a4203))


### BREAKING CHANGES

* the command is claude-term-tabs (alias ctt); re-link
bin/claude-term-tabs and regenerate the completion script. Config,
cache and snapshots now live under claude-term-tabs: move
~/.config/claude-tabs, ~/.cache/claude-tabs and
~/.local/state/claude-tabs to keep them.

# [1.3.0](https://github.com/ecoutu/claude-tabs/compare/v1.2.1...v1.3.0) (2026-11-11)


### Bug Fixes

* **cli:** reject --terminal names that are not terminals ([7e3b1b3](https://github.com/ecoutu/claude-tabs/commit/7e3b1b3236a38b316400e3f7a6640818d797d433))


### Features

* **cli:** complete ct's subcommands and flags in bash and zsh ([dda1450](https://github.com/ecoutu/claude-tabs/commit/dda1450813facd5b3f30673fe99baec7f48c4167)), closes [#15](https://github.com/ecoutu/claude-tabs/issues/15)

## [1.2.1](https://github.com/ecoutu/claude-tabs/compare/v1.2.0...v1.2.1) (2026-11-11)


### Bug Fixes

* **cli:** list the pause and resume subcommands in --help ([8c3f7da](https://github.com/ecoutu/claude-tabs/commit/8c3f7dad5b8561df1a190f20d955eea55e5209aa))
* **cli:** print the help for ct pause -h and ct resume -h ([b63ba4b](https://github.com/ecoutu/claude-tabs/commit/b63ba4b575ed5b3d07b9e88b9eeba3c6f064cc94))

# [1.2.0](https://github.com/ecoutu/claude-tabs/compare/v1.1.1...v1.2.0) (2026-11-11)


### Features

* **config:** leave closed sessions in excludeDirs out of --all ([#17](https://github.com/ecoutu/claude-tabs/issues/17)) ([35979ca](https://github.com/ecoutu/claude-tabs/commit/35979ca6724138749e12d00c75d8e6396546afd3))
