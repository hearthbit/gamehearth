# Contributing

Thanks for taking an interest in Gamehearth. Bug reports, ideas and pull requests are welcome.

- **Open an issue first** for anything bigger than a small fix, so we can agree on the direction before you spend time on it. The reasons behind the current design are in [docs/design.md](docs/design.md); a change that goes against a decision there should say why.
- **Security problems** do not belong in a public issue; see [SECURITY.md](SECURITY.md).
- **Before a pull request:** `npm install`, `npm test` and `npm run typecheck` pass; for changes to the UI or the server, `npm run e2e` too (see the [README](README.md#development)). New behavior comes with a test.
- **Language:** code, docs, commit messages and issues are in English. The UI has German and English texts; a new text needs both.
- **Games** do not belong in this repo. Create your own with `npx gamehearth new my-game` and publish it in your own catalog (see the [starter repo](https://github.com/hearthbit/gamehearth-starter)).

By contributing you agree that your contribution is licensed under the license of the part you change: AGPL-3.0 for the server and the client, MIT for the SDK, the dev tool and the templates.
