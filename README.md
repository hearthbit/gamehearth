# Gamehearth

A self-hostable open-source game platform for your own circle. The server runs as one Docker container, the client is a PWA that the server serves itself. Games are installed from catalogs, and only the ones you want. Single player and multiplayer, turn-based or realtime, everyone on their own device or with a TV and phones as controllers.

Games are open source and built so that non-programmers can also develop them with AI agents: a small SDK, a strict reducer contract, a dev tool with automatic bot test runs.

**Website:** [hearthbit.github.io/gamehearth](https://hearthbit.github.io/gamehearth/) explains the concept. **Make a game:** `npx gamehearth new my-game` (or the [starter repo](https://github.com/hearthbit/gamehearth-starter)). **Games:** the [Gamehearth catalog](https://github.com/hearthbit/gamehearth-catalog) lists Mau-Mau, Farbfelder (Color Fields), Mauerbrecher (Wall Breaker), Angelteich (Fishing Pond) and Kritzelkiste (Doodle Box). On npm: [`@gamehearth/sdk`](https://www.npmjs.com/package/@gamehearth/sdk) and [`gamehearth`](https://www.npmjs.com/package/gamehearth).

## What it does

Turn-based card games with hidden hands, realtime party games with a TV and phones as controllers, single-player games that work offline, and draw-and-guess with free text input. Accounts exist by invite, guests join via link or QR code, notifications say when it is your turn. Games can declare options and house rules, keep profiles with items and stats per player, offer bots for empty seats and play sounds and music through the platform. The UI ("Neon hall", with two more themes) is in German and English.

- The SDK core is in [packages/sdk](packages/sdk) (`@gamehearth/sdk`), with docs on the game contract and the client SDK (`@gamehearth/sdk/client`) in [packages/sdk/README.md](packages/sdk/README.md).
- Mau-Mau is the first game, with a UI in Phaser 4. It lives in its own repo [hearthbit/gamehearth-mau-mau](https://github.com/hearthbit/gamehearth-mau-mau) and is in the [Gamehearth catalog](https://github.com/hearthbit/gamehearth-catalog), like the other games. Here, under [fixtures/mau-mau](fixtures/mau-mau), is only a frozen copy for the tests.
- The dev tool is in [packages/devtool](packages/devtool) and is called `gamehearth` on npm: `new` creates a game from the template (with `AGENTS.md` for AI agents and the example game Card Duel), `dev` starts it locally with all seats side by side, bots and readable errors, `check` checks it (`npm run gamehearth -- check fixtures/mau-mau`), `pack` builds the game package from it, `catalog add` enters a package into a `catalog.json`.
- The templates are in [packages/devtool/templates](packages/devtool/templates): `turn-based` (Card Duel), `realtime` (Tag, TV and phones) and `single` (Mushroom Hunt, alone and offline, with save and best time). `npm run starter -- ../gamehearth-starter` writes the snapshot for the public starter repo from them.
- Games come from catalogs: an admin adds a catalog in the admin view (the dialog says what they entrust to it), installs games, applies updates, picks an older version or removes a game. Running matches play to the end on their build. Details in [packages/server/README.md](packages/server/README.md#games-and-catalogs).
- The server is in [packages/server](packages/server): rooms, matches, WebSocket, sandbox for game code and serving the UI and the games.
- The UI (PWA) is in [packages/client](packages/client): login, creating and joining rooms, lobby with QR code, game in an isolated iframe, new round, account page and admin view.
- Accounts exist only by invite from an admin; guests join via link, QR code or code. How the first admin is created is under [Docker](#docker). With a transfer code you take your session to another device or into the installed iPhone app.
- Realtime: games with `tick` run on the server at 20 ticks per second; inputs from the phones are collected until the next tick, the screen smooths the movement (`createTimeline` in the client SDK). The match pauses when a phone or the TV is missing, and counts down afterwards. You pair a TV by opening `/tv` on it and typing the code in the lobby or scanning the QR code; it needs no account and sees only what everyone sees. In the monorepo the small test game [fixtures/wettlauf](fixtures/wettlauf) checks this path.
- Options: a game with `options` in the manifest gets an "Options" ("Optionen") card in the lobby; only the host chooses, the match gets the choice as `ctx.options`, the client as `update.options`. In the monorepo the test game [fixtures/gluecksrad](fixtures/gluecksrad) checks this path.
- Profiles: `items`, `stats` and `flags` in the manifest, `ctx.profiles` and `ctx.profile` in the rules, `update.profile` in the client, the game page at `/game/<id>` with profile and leaderboards. Guests play with a throwaway profile per match. In the monorepo the test game [fixtures/dorfladen](fixtures/dorfladen) checks this path; details in [packages/sdk/README.md](packages/sdk/README.md#profiles) and [packages/server/README.md](packages/server/README.md#profiles).
- Single player: a game with `"mode": "single"` and `"server": false` calls `connectSolo()` and gets a save and best scores (`stats` in the manifest). "Play" ("Spielen") opens it without a room. Online the app preloads the files of every single-player game into the browser cache; offline the home page shows "Offline playable" ("Offline spielbar"). In the monorepo the test game [fixtures/sammler](fixtures/sammler) checks this path; details in [packages/client/README.md](packages/client/README.md#single-player-and-offline) and [packages/server/README.md](packages/server/README.md#single-player).
- Web push: whoever's turn it is and who does not have the app open gets "Your turn" ("Du bist dran") on all devices where they turned on notifications; at the end of a match "Match is over" ("Partie ist vorbei"). Rooms can be muted. Details in [packages/server/README.md](packages/server/README.md#web-push).

All decisions and the order of the next steps are in [docs/design.md](docs/design.md).

## Development

Requires Node 22 or later.

```bash
npm install
npm test
npm run typecheck
```

Build everything and start the server with the UI on http://localhost:8080:

```bash
npm run server
```

`npm run server` installs the games from `fixtures/` as "local" games (`GAMES_DIR`), without a catalog. With two browsers (or a normal and a private window) you can play a match for two this way. For work on the UI, `npm run dev` starts a Vite server with instant reload next to it.

Browser tests with Playwright (once: `npx playwright install chromium`):

```bash
npm run e2e
```

builds everything, starts its own server with fresh data and checks invite, login, guest join, logout and a whole match for two, a realtime match with a TV and two phones (pairing, countdown, smooth movement, pause, end); plus the isolation of the game iframe, web push and installation from a catalog (the test packs the Mau-Mau copy in two versions and puts them with a `catalog.json` on its own small server; against an external server it is skipped). For push the test starts a fake push service on port 8198 that decrypts every message and checks its VAPID signature; the server allows it via `PUSH_HOSTS`. Chromium in headless mode knows no notifications; the tests therefore replace only permission, subscription and display in the browser; encryption, sending and the service worker's handlers run for real. The tests create admins via the emergency command `admin-link`. Against an already running server, e.g. a container, this works with `GAMEHEARTH_URL=https://… GAMEHEARTH_ADMIN_LINK_COMMAND="ssh … admin-link" npm run e2e`; without the command the tests are skipped. Against an external server only logout runs from the push tests, because it cannot reach the fake push service. Caution: the tests create accounts and rooms there.

## Docker

```bash
docker build -t gamehearth .
docker run -p 8080:8080 -v gamehearth-data:/data gamehearth
```

The image builds the UI and the server and starts the server as user `node`. It brings no games; they come from a catalog via the admin view (for that the server must reach `raw.githubusercontent.com` and `github.com` over HTTPS). Database, backups and installed game builds are under `/data`. Behind a reverse proxy like Caddy, set `-e TRUST_PROXY=1`; more settings are in [packages/server/README.md](packages/server/README.md).

On first start the log contains a setup link (`docker logs <container>`); whoever appends it to the server's address and opens it creates the first admin. If an admin has forgotten their password:

```bash
docker exec <container> node packages/server/dist/admin.js reset-link <username>
```

The server is built to be openly reachable on the internet (rate limiting of logins, CSRF protection, secure cookies), but for that it needs HTTPS through a reverse proxy.

For web push the container must reach the browsers' push services (Google, Mozilla, Apple, Microsoft, outgoing over HTTPS); there is nothing to set up. The server generates the key itself in the database on first start. Whoever wants to give the push services a contact address sets `PUSH_CONTACT=mailto:…`.

## This repo

Monorepo of the platform: server, PWA client, SDK and dev tool, plus test copies of games under `fixtures/`. The games themselves and the catalog live in their own repos ([gamehearth-mau-mau](https://github.com/hearthbit/gamehearth-mau-mau), [gamehearth-farbfelder](https://github.com/hearthbit/gamehearth-farbfelder), [gamehearth-mauerbrecher](https://github.com/hearthbit/gamehearth-mauerbrecher), [gamehearth-angelteich](https://github.com/hearthbit/gamehearth-angelteich), [gamehearth-kritzelkiste](https://github.com/hearthbit/gamehearth-kritzelkiste), [gamehearth-catalog](https://github.com/hearthbit/gamehearth-catalog)), the starter repo [gamehearth-starter](https://github.com/hearthbit/gamehearth-starter) is a snapshot of the template from `packages/devtool/templates`. The website is under [site/](site), its screenshots come from `npm run site:shots`.

SDK and dev tool are published to npm by a tag on this repo (`sdk-v<version>` or `devtool-v<version>`, see [.github/workflows/publish.yml](.github/workflows/publish.yml)).

## Contributing

Issues and pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). Please report security problems privately as described in [SECURITY.md](SECURITY.md).

## License

Copyright (C) 2026 The Gamehearth contributors.

Server and client are under the [GNU Affero General Public License v3.0](LICENSE). SDK, dev tool and templates are under MIT, with their own license file in each package.
