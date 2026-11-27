# gamehearth

Dev tool for games on [Gamehearth](https://github.com/hearthbit/gamehearth-starter), a self-hosted game platform. Games can be made with an AI agent, also by people who don't program.

| Command | Purpose |
|---|---|
| `new` | creates a new game from the template |
| `dev` | starts the game locally with all players side by side in the browser |
| `check` | checks the game like the platform does, with hundreds of bot matches |
| `pack` | builds the game package for a catalog |
| `catalog` | maintains a `catalog.json` |

## Quick start

You need Node 22 or newer.

```bash
npx gamehearth new my-game
cd my-game
npm run dev
```

Then open http://localhost:5180. Open the folder with an AI agent (Claude Code, Cursor, Copilot …) and describe the game you want to make; the instructions for the agent come with the game as `AGENTS.md`.

In a game or catalog repo the dev tool starts with `npx gamehearth <command>` or through the npm scripts of the game, in the platform monorepo with `npm run gamehearth -- <command>`.

## new

```bash
npx gamehearth new <folder> [--name "Connect Four"] [--template turn-based|realtime|single] [--no-install] [--no-git]
```

`new` creates a game from the template in a new or empty folder and asks no questions, so that an agent can call it too:

- The `id` comes from the folder name (`Connect Four` becomes `connect-four`, umlauts are transliterated). A folder that gives no valid `id`, or a folder with content, is rejected.
- The display name comes from `--name`, otherwise from the `id`. `new` writes it as one plain text into `manifest.json` (it then applies to every language) and as `name` into `client/src/texts.ts`.
- `manifest.json` and `package.json` require the SDK and the dev tool in the version `new` ran with (for example `^0.1.6`, `^0.8.0`).
- `LICENSE` is MIT for the code and CC0 for graphics; the holder is `git config user.name`, otherwise "the authors of <game>". `AGENTS.md` tells the agent to ask about the license and the name before the first release.
- Then `new` creates a Git repo with the branch `main` that the CI of the template listens to (without a commit; not if the folder is already inside a Git repo) and runs `npm install`. `--no-git` and `--no-install` skip that. Without the installation, the `package-lock.json` that the CI of the template (`npm ci`) needs is missing: run `npm install` before the first push and commit the file.

There are three templates, all with Phaser 4, Vite and TypeScript. The old names `rundenbasiert`, `echtzeit` and `einzelspieler` still work.

- `turn-based` (the default): everyone on their own device, with the small example game **Card Duel** for 2–4 players (secret deck, hidden hand, everyone plays a card face down at the same time), which shows all three state areas, a hidden choice without a leak, randomness, an option (number of rounds), the end and a profile: whoever wins gets a win (`wins`, with leaderboard) and a joker (`joker`), which makes a played card count double and is used up doing so.
- `realtime` (`--template realtime`): a TV shows the field, the phones are controllers. The example **Tag** for 2–6 players shows `tick` with a time limit, inputs as a held direction, integer movement and distances, the roles `screen` and `controller` with `connect({ screen: true })`, smoothing with `createTimeline` (in `client/src/screen.ts`) and a controller with a d-pad that also works by keyboard (`client/src/controller.ts`), an option (duration) and at the end a win in the profile for everyone who was the catcher for the shortest time.
- `single` (`--template single`): a game played alone, without rules on the server (`"mode": "single"`, `"server": false`), also offline. The example **Mushroom Hunt** runs through 3 mazes and collects mushrooms: arcade physics with walls (`client/src/scene.ts`), levels as text grids with a check that every mushroom can be reached (`src/levels.ts`), a save with a format number, unlocked levels and the current run (`src/rules.ts`), `connectSolo` with `game.save` and `game.record`, a best time (`"better": "lower"`, format time) under `stats`, a menu as HTML and a d-pad that also works by keyboard (`client/src/controls.ts`).

All three speak English and German (`"languages": ["en", "de"]`), with the manifest texts per language and every UI text in `client/src/texts.ts` (`defineTexts`, chosen with `game.language`); the German is an example of a translation. Each brings a 4:3 pixel-art cover `client/public/cover.svg` (CC0, `"cover": "cover.svg"`), which the build copies into the client folder and `new` copies along.

Layout of the templates:

| Path | Content |
|---|---|
| `AGENTS.md`, `CLAUDE.md` | instructions for AI agents (Claude Code reads `CLAUDE.md`, which only points to `AGENTS.md`) |
| `README.md` | rules and commands for humans |
| `manifest.json`, `LICENSE` | manifest and license |
| `src/` | the rules (for `turn-based` and `realtime` the reducer, for `single` levels and save without Phaser) |
| `client/` | the UI with Phaser 4 (for `realtime` TV and controller); what it decides is in `client/src/view.ts`, without Phaser |
| `test/` | rule and UI tests with Vitest |
| `.github/workflows/` | CI for types, tests and `check`; release CI that builds the package on a tag `v*` and attaches it to a release |

The npm scripts of the template: `dev`, `build`, `build:watch`, `test`, `typecheck`, `check` (builds the UI first) and `pack` (likewise). `build` writes to `dist/client` (that goes into the package), `build:watch` for `dev` with source maps to `dist/dev-client`, so that the two don't get in each other's way. For the contract, `AGENTS.md` points to the READMEs of the SDK and the dev tool in `node_modules`, so that the instructions don't go out of date after an update.

## dev

```bash
npx gamehearth dev [game-folder] [--build "<command>"] [--client <folder>] [--port 5180] [--host] [--players <n>]
```

In the template, `npm run dev` starts the command with `--build "npm run build:watch" --client dist/dev-client`. `dev` is a small server for development only, without login, lobby and database:

- **All seats side by side** at http://localhost:5180, each in a phone-sized frame. At the top you choose the player count (from the manifest) and start a new match. Every seat has its own address (`/p1`, `/p2` …) for a second window; with `--host`, `dev` is also reachable on the Wi-Fi, for example for a phone. The seats are called Anna, Ben, Clara and so on, so that names of different lengths stand out in the layout.
- **Like on the platform:** The rules run in the same QuickJS sandbox as on the server, with the same time limit of 100 ms per call (message "Time limit … exceeded"). Whatever gets around this limit, for example a very expensive `sort`, is stopped by a worker with a hard limit of 2 seconds; after that it restarts. The UI runs in the iframe with the same sandbox and CSP, and `dev` talks to it over the same protocol as the platform. A new match reloads the frames, as the platform does for every round. Like the server, `dev` does not serve game files as a page of their own.
- **Profiles:** Below every seat its profile can be expanded as JSON ("Profile of p1"). "Apply" checks it like the server, rejects IDs that are not in the manifest and, in a running match, recomputes the legal moves, as the platform does when another match of the same player changes the profile: if the moves change, the version goes up, otherwise not. If the profile changes while you type in the field (for example because of a bot), the box says so; "Discard" fetches the current state. The profiles are stored in `.gamehearth/dev-profiles.json` in the game folder (in the `.gitignore` of the templates), in the form `{ "seats": { "p1": { "items": {…}, "stats": {…}, "flags": {…} } }, "guests": ["p2"] }`. Every new match starts with the saved profile; every change by moves and ticks (checked against the catalog in the manifest) and every edit is in the file right away and survives a restart of `dev`. If you change the file by hand, start a new match afterwards; otherwise the next move overwrites the profiles of all seats of this match. "Guest" at a seat starts a new match in which this seat plays with an empty profile that `dev` does not save. When replaying, `dev` plays the edits at their place; if it stops earlier, later edits apply from there. If the new rules already fail while setting up, the profiles stay at the last state, and edits apply to the next match. If the file is not valid JSON or has a wrong form (for example an unknown key or an invalid seat), the affected seats play with empty profiles, the page shows the error, and `dev` writes nothing to it. A match that started like this saves nothing even after the repair, so that it does not overwrite the repaired values with empty ones; only the next new match reads and writes the file again. If the file cannot be written, that is shown on the page too. The frames get their own profile with every update (`update.profile`).
- **Options:** If the game has `options` in the manifest, they are at the top next to the player count as select fields, set to `default` at the start. Another choice starts a new match with these options; "New match" and another player count keep the choice. The frames get the options with every update (`update.options`). If the options in `manifest.json` change, a new match starts, and unknown options and values fall back to the default.
- **Languages:** If the manifest has `languages`, a selector in the header offers them, starting with the first. Every frame (seats, TV, single player) gets the chosen language as `language` in the `update` and `solo` messages, so `game.language` is the same as on the platform; a change reloads the frames, and the single-seat pages (`/p1`, `/tv`) follow it, also in another window. Names and labels from the manifest (game name, options) are shown in the chosen language. Without `languages` the selector is hidden and the frames get no language (`game.language` then falls back to the browser's language).
- **Bots:** Every seat can be set to "Bot". If the game has a `bot` function, the seat plays with it, as on the platform: turn-based through `botMove` after a short pause, in realtime through `stepMatch` with the seat in `bots` (asked in every tick). Without `bot` the seat makes a random legal move after a short pause (in realtime a random input with a probability of 20% per tick), with placeholders (`text()`, `int()`) filled by random values like in `check`. If `bot` throws, picks a move that is not legal or tries to change what it gets, the seat plays a random legal move instead (in realtime no input), as on the platform, and the problem shows as a banner ("Problem in bot for p2") and once in a row in the terminal; the match is not paused. The frames get bots with `bot: true` in `players`. Moves of the UI count as legal if they fit a placeholder. Bots stay on in a new match. If a bot's move fails because of the game code, this bot pauses ("paused") until the rules are reloaded, a new match starts or it is switched on again.
- **Away:** In a realtime game with `"away": "play-on"`, every phone has an "Away" switch. An away seat goes to `stepMatch` as `away`, so the game sees it in `ctx.away`, and its frame is dimmed; a bot seat is never away. Unlike the platform, `dev` does not pause when every seat is away. Other games have no such switch; they pause on the platform instead.
- **Sound:** The frames play sounds with `game.sound(…)`; `dev` synthesizes them with Web Audio like the platform (named sounds from the SDK or own notes, at most 12 per second and frame), but only while the "Sound" switch in the header is on. It is off by default, like on the platform, and the page remembers it in the browser. Every frame, the TV and single-player games included, gets `{ type: "settings", sound }` after it has started and whenever the switch changes, so `game.soundOn` follows the switch. The header names the last sound and the frame that played it (`♪ p1: coin`), so it can be checked without speakers.
- **Music:** The frames play looping tracks with `game.music(…)`; `dev` plays them with the SDK's music player like the platform (`createMusicPlayer`: looped on the audio clock, a crossfade of about a second to another track, at most one change per 300 ms, the same track keeps playing, paused while the page is hidden), but only while both "Sound" and "Music" in the header are on. As on the platform, "Music" is on by default and "Sound" off, so turning on sound brings the music along; the page remembers both in the browser. `settings` carries `music: true` only while both are on and no bot plays the frame's seat, so `game.musicOn` follows. Only one frame's track plays: the TV's, otherwise that of the first seat that has one and is not played by a bot; a frame that loads again starts without music. The header names the playing track next to the last sound (`♪ Forest`, or `♪ music` for a track without a name), but only while music actually plays, that is while the page's audio context runs. A `suspended` or `interrupted` context is resumed on the next click or key.
- **Insight:** Below every seat, the snapshot its client gets can be expanded; at the bottom the whole state including `secret`, the moves and the seed.
- **Realtime:** With `"mode": "realtime"`, `dev` computes 20 ticks per second like the server. Inputs wait until the next tick; if more than 4 are waiting from one seat, the oldest expires, and like the platform, `dev` rejects more than 30 inputs per second and seat with `rate-limited`. While paused (by hand or after an error), `dev` answers inputs right away and keeps the last one per seat for the next tick, also for "One tick". If the game has the role `screen`, also an optional one, a "TV" frame in landscape format is in front, with its own address `/tv`; the phones get the role `controller`, or `player` if the game has that role (as with an optional TV). At the top there are "Pause"/"Resume", "One tick" (only while paused) and slow motion (half and quarter speed; the game time per tick stays 50 ms, the frames get the longer tick duration as `tickMs`, so that `createTimeline` keeps drawing smoothly). Bot seats press a random legal input in every tick with a probability of 20%, unless the game has `bot` (see "Bots"). Like the server, `dev` catches up on late ticks (at most 200 ms behind), so that the game time keeps pace with the clock. If a tick fails because of time, memory or a crash of the sandbox, `dev` computes it once more like the server. An error in `tick` pauses the match ("Tick N failed" or "Error in tick (tick N)"); "Resume" tries again. `dev` reports illegal inputs as an error of the UI only if they were not in `snapshot.moves` already on arrival; what only becomes illegal through an earlier input in the same tick is not an error. If the rules change, the ticks stand still until they are loaded, then a new match starts with the same seed, the same seats and bots, instead of replaying; the same inputs would run differently with new rules anyway. Countdown and pauses of the platform (missing phone, missing TV) do not exist in `dev`. The list of moves shows only the last inputs.
- **Reloading means replaying:** If something under `src/` or `manifest.json` changes, `dev` bundles again and replays the same match from seed and moves with the new code. If a move is no longer legal or the code throws, it stops there and says why; "New match" starts over. If the player count no longer fits the manifest, a new match starts. If the rules cannot be built or cannot be loaded in QuickJS, the last version keeps running.
- **Reloading the UI:** The command from `--build` keeps rebuilding the client (its output is in the terminal with `[build]` in front). The folder from `--client` is served, otherwise the one from `manifest.json`. `dev` notices from the built `index.html` that a new build is there, and reloads the frames if the content of the folder has changed (source maps don't count); the match stays. A build that gives the same result, for example because the UI imports a function from `src/` and only the rules changed, reloads nothing, and while a build briefly empties the folder, the frames stay; if a frame is loaded in this gap, the request waits up to 10 seconds for the build instead of failing with 404.
- **Single player:** With `"mode": "single"` and `"server": false` there are no rules, match, seats, bots or ticks. The page shows one frame in the size from `roles.player.screen` (`small` 360 × 640, `medium` 800 × 500, `large` 960 × 600) and below it the save and the best scores with "Reload", "Delete save" and "Delete best scores". Both are in `.gamehearth/dev-save.json` in the game folder (in the `.gitignore` of the template) and survive a restart of `dev`; if you edit the file by hand to jump straight to a certain point, reload afterwards. `dev` checks `game.save` and `game.record` like the platform: a best score that is not under `stats` and an invalid save show up as an error on the page and in the terminal; best scores keep the better value according to `better`. If `mode` or `server` change, `dev` says that it has to be restarted.
- **Readable errors:** Errors from the sandbox (with phase, seat and move) and from the iframe (uncaught errors, `console.error`) show up as a banner on the page and as a block of text in the terminal, with the location in the source code via the source maps (`src/game.ts:70:17`, `client/src/view.ts:41:11`; stacks from Chrome, Firefox and Safari). A button copies the text for the agent. An error stays until a human at this table makes a successful move again; bot moves don't clear it. The same error is shown only once in a row in the terminal. `console.log` from the UI is in the terminal with the seat in front, with control characters removed. If a UI sends a move that was not in its `moves`, that is shown in the terminal.
- **Port:** The default is 5180. If it is taken, `dev` takes the next free one and says so; the valid address is always in the output. An explicitly chosen `--port` is not replaced; if it is taken, `dev` stops.
- **Who may access it:** `dev` listens only on `127.0.0.1`. It only answers requests to `localhost`, an IP address or a Codespaces address (`*.app.github.dev`), so that a foreign web page cannot reach it through a redirected domain name. It only accepts moves and settings from its own page (origin equal to the host, also behind HTTPS). With `--host` it listens on all addresses: then every device in the same network can see and control all seats including `secret` and write text to the terminal. Only use it on your own Wi-Fi. `dev` has not been tried in Codespaces.

Limitations: The match lives only in memory; a restart of `dev` starts a new match (the profiles stay). Taking back a move is not possible yet. A move that meets an outdated state (for example because a bot just moved) is rejected as `stale` like on the server; you then tap again. Ctrl+C stops `dev` together with the build process; a second Ctrl+C aborts the cleanup.

## check

```bash
npx gamehearth check .
```

`check` checks a game so that errors stand out before anyone plays it, and reports them so that an AI agent can fix them directly.

1. **Manifest**: required fields, player count, roles, licenses (OSI license for code, CC0/CC-BY/CC-BY-SA for assets), unknown fields (typos) and whether the required SDK version (`"sdk": "^0.1.1"`) fits the installed SDK. Realtime games (`"mode": "realtime"`) need at least `"^0.1.1"`, because older servers don't know `tick`. Game options (`options`, see the README of the SDK) exist only with a reducer and from `"^0.1.3"`; names, types, display names, values and default are checked. Optional are `description` (1 to 200 characters, shown in the catalog and on the game page) and `repository` (`https` URL of the source code). The catalog of the profiles (`items`, `stats`, `flags`, see the README of the SDK) needs `"^0.1.4"` for games with a reducer; names, display names, `better`, `format`, `deprecated` and the limits (1,000 items, 200 stats, 200 flags) are checked. Single-player games without a reducer have only `stats` as best scores, each with `better`, at most 10. `languages` lists 1 to 20 language codes (`"en"`, `"de"`, `"pt-BR"`), the game's default first; `name`, `description` and every `label` are then a text for all languages or an object with one text per language (`{ "en": "Wins", "de": "Siege" }`). An object needs `languages`, and a language missing in it or not listed in `languages` is an error. In a game with several languages, `check` lists all plain texts in one warning (not `name`, which is often a proper name; a text that is the same in every language may stay plain). `languages` and `cover` need `"^0.1.6"`. The TV (`roles.screen`) may be marked `"optional": true`, only next to the role `player` and from `"^0.1.7"` (also with `false`, because older servers don't know the field); the match then starts and runs without a TV. `"away"` is `"pause"` (the default) or `"play-on"` (the match goes on without seats whose phone is gone, see the README of the SDK), only for realtime games and from `"^0.1.8"`. A file with a BOM, as PowerShell likes to write it, is no problem.
2. **Client**: The folder from `"client"` in the manifest (for example `"dist/client"`) must be built, be inside the game folder and contain an `index.html`. At most 5,000 files and 50 MB are allowed, no symlinks and only file names made of letters, digits, spaces and `._@+~()-`. If the folder is missing, `check` reports it as an error and plays all matches anyway. If the manifest names a `cover` (a path inside the client folder ending in `.png`, `.webp` or `.svg`), the file must be in the built folder, really have that type (PNG signature, WebP `RIFF … WEBP`, SVG as UTF-8 text with an `<svg>` root element), have at most 256 KB and the aspect ratio 4:3 within 3 % (from the PNG or WebP header, for SVG from `width` and `height`, otherwise from the `viewBox`). `pack` and the server (`inspectPackage`) check the cover the same way.
3. **Building**: The game is bundled into one file from `src/index.ts`, exactly as on the server. Only files from the game folder (code and JSON data) and the SDK may be included; an import like `../../package.json` or an absolute path stops with a clear message. Node modules like `fs` are not allowed in games and are caught here, as is a missing `export default`.
4. **Bot matches**: 200 matches with random bots for every allowed player count up to 8, above that only minimum and maximum. Bots fill placeholders in `legalMoves` with random values (texts of every allowed length with letters, umlauts, emoji and punctuation, numbers often at the edges), so `check` also finds crashes on typed garbage. A game with placeholders needs `"sdk": "^0.1.7"` in the manifest; otherwise that is an error. After every move the match is saved and loaded. Errors in the game code are reported with phase, seat and stack trace. The stack trace points to the line in the game; lines from the SDK and the dev tool are filtered out.
5. **Forbidden functions**: `Math.random()`, `Date.now()` (also via `new Date(0).constructor` or the property descriptor), `new Date()` without an argument, `performance.now()` and `crypto.getRandomValues()`/`randomUUID()` throw an error right away while checking, with a pointer to `ctx.random` and `ctx.now`, already while loading the game. Likewise everything that depends on the time zone of the computer: date methods with local time like `getHours()` or `toString()`, `Date.parse()` and `new Date` with text or several arguments; allowed are `new Date(number)`, `Date.UTC(...)` and the UTC methods. If the game catches this error with `try`/`catch`, `check` reports the call anyway.
6. **Determinism**: Every match is repeated from seed and moves, while a second match with another player count runs in the same module between the moves. If a state differs, `check` names the move and the location, for example `match.state.public.count: on the first run 6, on the repeat 7`. This finds variables outside the functions, also ones that `setup` remembers: on the server many matches run at the same time in the same module.
7. **Options**: If the game has `options`, the matches of every player count run alternately in several variants: once all options at their default, then every other value of an option once, with the rest at their default. If there are not enough matches for all variants, `check` plays that many more. In QuickJS at least one match per variant is replayed. `check` counts per variant whether matches too often do not end. Findings name the changed options, and the command to replay sets them with `--option`.
8. **Matches without an end**: If a match does not end after 5,000 moves, there is a warning, and for the majority of the matches an error. After three such matches per player count, the rest are skipped.
9. **Infinite loops**: The matches run in worker threads. If game code does not respond for more than 3 seconds, `check` aborts and reports phase, seat, move and seed. After two hanging matches per player count, the rest are skipped.
10. **Suspicious things**: Warnings when a legal move changes neither the state nor a profile (usually a `case` is missing in `apply`) and when `setup` uses randomness but returns the same start for every seed (usually the result of `random.shuffle` was discarded).
11. **Leaks**: after every move, see below; for realtime every 10 ticks.
12. **Engine of the server**: The server runs games in QuickJS, not in Node. That is why `check` replays the first 10 matches per player count (realtime: 2), plus one match of every option variant not among them, with the fewest players, also in the same sandbox as the server (prelude, time limit of 100 ms per call, memory cap, stack limit of 256 KB) and compares every state. After the first error the replaying stops; there is no hard limit like in the server worker in `check`, so a very long call of a built-in function holds up the check run. If a match fails there, that is an error; typical causes are functions that do not exist in QuickJS (`console`, `structuredClone`, `Intl`, `TextEncoder`, `atob`, `URL`), `eval` or a move that is too slow. If it runs differently, there is a warning; usually `Math.sin`, `Math.exp`, `Math.pow`, `Math.hypot` and related functions compute the last digits differently, or `localeCompare`, `toLocaleString` or an inconsistent comparator for `sort` behave differently.

13. **Realtime**: With `"mode": "realtime"` the game must have `tick`; other games must not have one. Instead of move by move, `check` plays tick by tick: in every tick every bot presses a random legal input with a probability of 20%, then `tick` computes. 20 matches are played per player count, 2 of them also in QuickJS. If a match does not end within 10 minutes of game time (12,000 ticks), that is always an error: realtime games need an end, for example a time limit. Like the server, `check` computes a single timeout in QuickJS once more on a fresh sandbox and reports it only if it repeats. If a tick including inputs takes more than 10 ms on average or more than 40 ms at peaks in QuickJS, there is a warning, because at 20 ticks per second all rooms of the server have to fit into 50 ms. Findings name the tick instead of the move. The warning "a legal move does not change the state" is dropped, because an input like "keep going left" often changes nothing.
14. **Profiles**: If the manifest has `items`, `stats` or `flags`, every seat starts with an empty profile (like new players and guests) or one filled at random from the catalog. `check` checks the profile changes of every move like the server; an ID that is not in the manifest is an error in the game code with location and suggestion. Between moves, `check` now and then takes items away, as a parallel match of the same player does, and has the moves recomputed with `refreshMatch`; for realtime the recomputing is dropped, because every tick recomputes the moves. If `legalMoves` then offers a move that `apply` rejects with `ctx.profile.use` because the item is missing, that is an error: the player would never get anywhere with this move. For realtime this applies to an input that fails with `missing-item` although nothing was taken away in this tick and no earlier input of the same tick got through. The repeat and QuickJS replay with exactly the same profiles; profile changes that differ on the repeat also count as nondeterministic.
15. **`ids.lock`**: see below.
16. **The game's bot**: If the game has a `bot` function, `check` plays more matches per player count in which `bot` plays every seat: 10 for turn-based games (`botMove`, then `applyMove`), 2 for realtime games (`stepMatch` with every seat in `bots`, so `bot` is asked in every tick); `--bot-games` changes the number, 0 turns them off. Their seeds are `check-bots-<players>-<number>`, and they take turns through the option variants like the other matches. Errors with seat, move or tick and the text of the problem: a bot that throws, returns a move that is not legal or tries to change the state, its moves or the profiles (they are read-only in `bot`; on the platform the seat then gets a random legal move, in realtime no input), a bot that hangs, a bot that picks a different move when the match is repeated, and a match of bots that does not end (after 5,000 moves, in realtime after the game time limit). The first 2 of these matches per player count (realtime 1) are also replayed in QuickJS; a bot that picks differently there is a warning, one that fails there an error. The report lists them separately ("Matches in which the game's bot plays every seat"), and the command to replay one has `--bots`.
17. **Seats that are away**: For a realtime game with `"away": "play-on"`, seats go away now and then during the random matches and come back a few seconds later (about every 10 seconds per seat, for about 2 seconds; never all at once, because the platform pauses when everyone is away). Away seats press nothing, and the game sees them in `ctx.away`. The away seats of every tick belong to the match, so the repeat and the QuickJS replay pass the same `ctx.away`, and the replay with `--seed` lists them (`Tick 120: away: p2`). An error during such a tick says which seats were away.

The matches are reproducible themselves: the same game code gives the same matches on every call. With every finding comes the command that replays exactly this match, including changed limits:

```bash
npx gamehearth check . --players 3 --seed check-3-17 --option rounds=7
```

Then `check` shows all moves of the match one by one (for realtime every input with its tick), also up to a spot where it hangs, and passes on output of the game (`console.log`). In the normal check run this output is swallowed; the progress is on stderr.

### Leaks

**Moves (errors).** For every player, `check` swaps the hidden values after every move, that is the texts in `secret` and in the areas of the other players, including sets of the form `{ "herz-7": true }`. What the player sees stays the same. If their legal moves change, they depend on data the player may not see, and reveal it to the player's client. An example is `{ type: "draw", card: "herz-7" }` with the top card of the pile. A fixed choice like rock, paper, scissors or all possible accusations in a detective game does not change and therefore does not count as a leak, even if the secret solution is part of it.

**Copies (warnings).** In addition, `check` looks for values that are open and hidden at the same time:

| Finding | Example |
|---|---|
| A value is in `public` and in `secret` at the same time | `public.next = secret.deck.at(-1)` |
| A value is in `public` and in the area of a player at the same time | a hand card is shown but stays in the hand |
| A value is in the area of p1 and at the same time in `secret` or with p2 | p1 gets a card of p2 as a copy |

Values are texts of 2 or more characters (except seat names), keys of sets and small objects in lists like `{ "suit": "herz", "rank": 7 }`, which are compared as a whole. Texts that currently occur as a choice in moves don't count. Revealing normally moves a value instead of copying it. Warnings can still be intended, for example a trump card lying face up under the pile or a role that a seer may see.

**Typed texts.** A text that a bot typed into a placeholder (also inside a small object like `{ "by": "p2", "text": "…" }`) may be in the areas of several players and in `secret` without a warning, because games route such texts on purpose, for example a chat that only those who have already guessed the word can read; whether it reaches the right players, `check` cannot know, the game's own tests have to show it. A small object counts as typed only if all its texts were typed, so a hidden value next to a typed text is still reported. If a typed text is in `public` and at the same time in `secret` or in a player's area, `check` still warns.

Both are heuristics, not a guarantee. They do not detect numbers and derived values (for example "the sum of p2's cards" in `public`).

### ids.lock

Profiles outlive game versions, so every published ID is forever. In the game folder, `check` maintains the file `ids.lock` with all IDs from `items`, `stats` and `flags` that the game ever had, similar to npm and its `package-lock.json`:

- `check` adds new IDs from the manifest itself and says so; the file belongs in the repo.
- If an ID is in `ids.lock` but no longer in the manifest, that is an error. The solution is almost always to add it back and mark it with `"deprecated": true`. Only an ID that was never published (for example yesterday's typo) may be deleted from `ids.lock` by hand.
- In CI (environment variable `CI` set, except `false` or `0`), `check` writes nothing and fails if the file is missing or out of date. That way no release ends up with an ID that is not recorded.
- Games without IDs need no `ids.lock`.
- All templates come with one (`turn-based`: `joker` and `wins`, `realtime`: `wins`, `single`: `best-time`), and `new` copies it. If you replace the example, its names drop out; they were never published and may therefore be deleted from `ids.lock` by hand.

The server does not need the file; it does not belong in the package. If an update no longer knows IDs that are in profiles on a server, the admin view names them and installs anyway.

### Single player without a reducer

With `"mode": "single"` and `"server": false` there are no rules on the server and therefore no bot matches. `check` then checks without a browser:

- the manifest including `stats` (name, `label`, `better`, `format`, `deprecated`; at most 10, each with `better`) and `"sdk"` from `^0.1.2`, only the role `player`, no `items` and `flags`,
- `ids.lock` for the names under `stats`,
- licenses and the built client folder like for every game,
- the game's own source code (all `.ts`, `.js` and related files in the game folder except `node_modules`, built folders and tests): an error is `connect` instead of `connectSolo` and a `game.record("name", …)` with a name that is not under `stats`. There are warnings for `localStorage`, `sessionStorage`, `indexedDB`, `document.cookie`, service workers, own connections (`WebSocket`, `EventSource`, `RTCPeerConnection`) and loading from foreign URLs, because all of that fails in the sandboxed iframe, and when `connectSolo` does not occur anywhere.

The source code is searched, not the built client: engines like Phaser bring their own calls of `localStorage`, which are caught in the iframe. Comment lines don't count. The game's own tests secure its rules.

### Options

| Option | Meaning |
|---|---|
| `--games <n>` | matches per player count (default 200, realtime 20) |
| `--players <n>` | check only this player count (must be allowed by the manifest) |
| `--seed <seed>` | replay exactly one match (with `--players`) |
| `--option <name>=<value>` | set a game option, also several times, the rest stay at their default; without `--seed` all matches then run with exactly this choice |
| `--max-moves <n>` | moves after which a match counts as "does not end" (default 5000) |
| `--max-seconds <n>` | game time in seconds after which a realtime match counts as "does not end" (default 600) |
| `--timeout <ms>` | time without progress after which game code counts as hanging (default 3000) |
| `--quickjs <n>` | matches per player count that also run in QuickJS (default 10, realtime 2, 0 turns it off); every option variant runs there at least once in total |
| `--bot-games <n>` | for a game with `bot`: matches per player count in which `bot` plays every seat (default 10, realtime 2, 0 turns them off) |
| `--bots` | with `--seed`: replay one of those matches (seeds `check-bots-…`) |
| `--json` | report as JSON |

The exit code is 0 without errors, 1 with at least one error (warnings don't count) and 2 for a wrong call.

### Limitations

- Games without a reducer (`server: false`) do not run in `check`; whether the client starts in the browser is only shown by `dev` or a browser test of your own.
- In realtime the bots press at random; a game that only ends when someone deliberately reaches a goal therefore also needs a time limit.
- Random bots don't play smart. Errors that only occur in rare, deliberately brought-about situations can slip through; your own rule tests help against that, as with Mau-Mau.
- The bans in Node only apply while checking. On the server, the prelude of the sandbox blocks the same functions, plus `eval` and the `Function` constructor; `instanceof Function` and `Function.prototype` keep working there.

## pack

```bash
npx gamehearth pack . [--out <folder>] [--max-seconds <n>]
```

`pack` first checks the game with `check` (as above, with all matches) and stops on errors; warnings are allowed and are counted. `--max-seconds` is passed on to `check`, for realtime games whose matches may last longer than 10 minutes of game time; a game sets it in its `check` and `pack` scripts in `package.json`. Then it builds the game package `<id>-<version>.zip` (default: `dist/` in the game folder) and names build, size and SHA-256. The client must be built beforehand (in the game repo `npm run pack` does that).

A game package is a ZIP with exactly these files:

| File | Content |
|---|---|
| `manifest.json` | the manifest, unchanged |
| `game.mjs` | the reducer, bundled with esbuild as when checking (only files from the game folder and the SDK), required with `server: true`, forbidden with `server: false` |
| `client/…` | the built client folder from `"client"` with `index.html`, at most 5,000 files and 50 MB |
| `LICENSE` | required, at most 256 KB |
| `README.md` | optional, at most 256 KB |
| `pack.json` | `{ "format": 1, "sdk", "devtool", "warnings" }`: versions when packing and number of warnings from `check`; does not count for the hash |

Like on the server, the build is called `<id>@<version>+<hash>`; the hash covers the manifest, `game.mjs` (an empty text for games without a reducer) and all client files. `pack` writes the ZIP deterministically (entries sorted, fixed timestamps, always compressed the same way): the same state gives the same checksum with the same Node version. Whole packages are at most 60 MB, `game.mjs` at most 5 MB.

A package is read strictly (`inspectPackage`, `readZip`), on the server as in `catalog add`: only deflate or uncompressed, no encryption, no ZIP64, no folder entries, no symlinks or device files, no paths with `..`, `\`, colon or control characters, no duplicate names (also not in different case), no comment, no data before, between or after the entries. The reader checks sizes and number of entries before it unpacks anything, and the CRC afterwards. All errors of a package come at once.

## catalog

```bash
npx gamehearth catalog add catalog.json <package-url> [--name <catalog-name>] [--replace]
npx gamehearth catalog check catalog.json [--download]
```

A catalog is a `catalog.json` (format below under `catalog add` and in the documentation of the platform under "Game packages and catalogs"): name of the catalog and per game `id`, name, description, repo link and versions with SDK range, mode, player count, roles, license, size, URL and SHA-256. A catalog has at most 500 games with 50 versions each and is at most 1 MB.

`catalog add` downloads the package from the URL (only `https`, `http` only from localhost), checks it like the server and adds the version with size and checksum. The versions are sorted in descending order; name, description and repo link come from the manifest of the newest version. `catalog add` writes name and description in the game's default language (the first of `languages`), so that servers before dev tool 0.8.0, which only know plain texts, can still read the catalog; the translations come with the installed manifest. For the same reason it leaves `optional` out of the TV role, which servers before dev tool 0.9.0 don't know, and a version entry never carries `away` (older servers reject a version entry with an unknown field); the installed manifest keeps both. A hand-written catalog may also give an object with one text per language (every key a language code, lengths as for a text: name up to 80, description up to 200 characters); only servers from 0.8.0 on read it. If the same version is already in it with another checksum or URL, the command stops, except with `--replace`. A new catalog needs `--name`.

`catalog check` checks the form of the file; with `--download` it also downloads every package and compares size, checksum, `id` and version (that is how the CI of the catalog repo checks it).

## Sandbox

Under `gamehearth/sandbox` is the sandbox core that the server and `check` share: a QuickJS module (via `quickjs-emscripten` 0.32.0, pinned, because the engine is part of the game build) with its own capped WebAssembly memory per sandbox, prelude, guest runner and check of the output. How the server uses it is in the README of the server in the platform repo.

## Developing the dev tool

In the platform monorepo the template is under `templates/turn-based` and runs there with tests, type check and `check`. A test checks that `AGENTS.md` only names files, paths and npm scripts that exist.

A version that is not on npm yet can be tried like an outsider would with locally packed tarballs:

```bash
npm pack --pack-destination <folder>        # in packages/sdk and packages/devtool
npx gamehearth new my-game --local-packages <folder>
```

`--local-packages` copies `gamehearth-sdk-<version>.tgz` and `gamehearth-<version>.tgz` to `vendor/` and includes them via `file:` (with `overrides`, so that there is only one copy of the SDK).

`npm run starter -- <folder>` in the monorepo writes the snapshot for the starter repo (`hearthbit/gamehearth-starter`): exactly what `new` creates as "My Game", with its own README for the home page.
