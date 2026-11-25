# Gamehearth starter

Template for games on **Gamehearth**, a self-hosted open-source game platform for your own circle: family, friends, your own server. Several people play on their own devices in the browser; the game rules run on the server, the UI in each player's browser.

Games can be made without knowing how to program: you open a new game with an AI agent (Claude Code, Cursor, Copilot …) and describe what you want to make. The instructions for the agent are in [AGENTS.md](AGENTS.md).

## Getting started

You need [Node.js](https://nodejs.org) 22 or newer.

```bash
npx gamehearth new my-game
cd my-game
npm run dev
```

Then open http://localhost:5180: all players sit there side by side, you can play each seat yourself or give it to a bot.

Alternatively choose "Use this template" on GitHub. Then run `npm install` and `npm run dev` in the new repo; the `id` in `manifest.json` and `package.json` is still `my-game` and should match the game before the first release.

## What's inside

This repo is exactly what `npx gamehearth new` creates: a small, complete example game, **Card Duel** for 2 to 4 players. Everyone plays a card face down at the same time, the highest gets a point, after five rounds whoever has the most points wins. It shows the most important patterns: public, own and secret areas in the state, a hidden choice, randomness and the end of a match.

| Path | Content |
|---|---|
| `AGENTS.md` | instructions for AI agents |
| `manifest.json` | name, version, player count, license |
| `src/` | the game rules |
| `client/` | the UI with Phaser 4 |
| `test/` | tests |
| `.github/workflows/` | CI with all checks; on a tag `v*` it builds the game package and attaches it to a release |

| Command | What it does |
|---|---|
| `npm run dev` | starts the game locally with all players in the browser |
| `npm test` | tests |
| `npm run typecheck` | type check |
| `npm run check` | checks the game like the platform does, with hundreds of bot matches |
| `npm run pack` | builds the game package for a catalog |

## Putting it on a server

A Gamehearth server installs games from **catalogs**: a `catalog.json` that lists game packages with size and checksum. For your own games you create your own catalog, for example as a repo with a `catalog.json`:

```bash
npx gamehearth catalog add catalog.json <package-url> --name "My catalog"
```

On the server, an admin adds the raw URL of the `catalog.json` in the admin view ("Verwaltung") and installs the game. Adding a catalog means trusting its games. The [Gamehearth catalog](https://github.com/hearthbit/gamehearth-catalog) lists only our own games for now.

## More

- SDK: [`@gamehearth/sdk`](https://www.npmjs.com/package/@gamehearth/sdk), the contract for rules and UI
- Dev tool: [`gamehearth`](https://www.npmjs.com/package/gamehearth) with `new`, `dev`, `check`, `pack` and `catalog`
- A larger example: [Mau-Mau](https://github.com/hearthbit/gamehearth-mau-mau)
- The platform (server, app, SDK and dev tool): [hearthbit/gamehearth](https://github.com/hearthbit/gamehearth), with the [concept website](https://hearthbit.github.io/gamehearth/)

Bugs and wishes for the template, SDK, dev tool or platform are welcome as [issues in the platform repo](https://github.com/hearthbit/gamehearth/issues).

## License

The template, SDK and dev tool are under MIT. A game from this template starts with MIT for the code and CC0 for graphics (see [LICENSE](LICENSE)); both can be changed before the first release.
