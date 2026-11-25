# @gamehearth/server

The Gamehearth server: installs games from catalogs, manages rooms and runs matches. Runs as one Node process with SQLite (`node:sqlite`) and WebSockets (`ws`); game code runs only in a QuickJS sandbox in its own worker thread (see [Sandbox](#sandbox)).

## Starting

```bash
npm run server
```

| Environment variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | Port for HTTP and WebSocket |
| `DATA_DIR` | `data` | Database, backups and installed game builds |
| `GAMES_DIR` | empty | development only: folder with game sources that the server builds as "local" games on every start (see [Games and catalogs](#games-and-catalogs)); `npm run server` and the browser tests set it to `fixtures/` |
| `CLIENT_DIR` | `packages/client/dist` | built platform UI (PWA); if it is missing, the pages answer with 503 |
| `MAX_PLAYERS` | `12` | upper limit per room (1 to 100), also for games without `players.max` |
| `TRUST_PROXY` | `0` | `1` if a reverse proxy like Caddy sits in front; then the last address in `X-Forwarded-For` (the one the proxy appended) counts as the address for rate limiting, and `X-Forwarded-Proto: https` as HTTPS (secure cookie). Then bind the port only to `127.0.0.1`, otherwise anyone can set the header themselves |
| `MAX_HOSTED_ROOMS` | `20` | open rooms (lobby or running) an account may have as host; admins without limit |
| `MAX_ROOMS_PER_USER` | `50` | rooms an account or guest sits in at the same time |
| `GUEST_DAYS` | `30` | days without activity after which a guest expires |
| `FINISHED_ROOM_DAYS` | `30` | days without activity after which finished rooms and lobbies after a round disappear |
| `IDLE_GAME_DAYS` | `90` | days without a move after which a running match disappears |
| `PUSH_CONTACT` | empty | contact for the push services in the VAPID `sub`, `mailto:…` or `https://…`; empty means: the address of the page on which the subscription was created (see [Web push](#web-push)) |
| `PUSH_HOSTS` | empty | further push services, comma-separated: host (`push.example.org`), pattern (`*.push.example.org`, only `https` on port 443) or full origin (`http://127.0.0.1:8198`, for example for tests) |

Invalid values, such as `MAX_PLAYERS=abc`, stop the start with a clear message.

## Setup and emergencies

As long as there is no admin, the server writes a setup link to the log on every start:

```
Gamehearth is not set up yet. Open this link on your server to create the first admin (valid for 24 hours or until the next start): /setup#…
```

You append the path to the server's address (`https://games.example.org/setup#…`). Whoever opens it creates the first account; it becomes admin, and the link is used up. Every start replaces an unused link.

For emergencies there is a command that opens the same database (`DATA_DIR` as for the server):

```bash
node packages/server/dist/admin.js admin-link --url https://games.example.org
node packages/server/dist/admin.js reset-link anna --url https://games.example.org
```

`admin-link` prints an invite for a new admin, `reset-link` a link to reset the password. Both are valid for 24 hours and once. In the container: `docker exec <container> node packages/server/dist/admin.js admin-link`.

## Games and catalogs

Games come as a **game package** from a **catalog** (decisions in `docs/design.md` under "Game packages and catalogs", format and dev tool in [packages/devtool](../devtool/README.md#pack)). An admin manages both in the admin view.

**Catalogs.** A catalog is a `catalog.json` behind an address. Adding one requires `trust: true` in the body (the UI first asks with a dialog what a game from it can do, see [Trust](#trust)). The server loads the file right away, then on request and once a day (checked during the cleanup every ten minutes), checks shape and size (at most 1 MB) with `validateCatalog` of the dev tool and stores the last good state with its time (table `catalogs`); if loading fails, the old state stays, and the admin view shows the error with its code (`errorCode`: `catalog-unavailable` when the file cannot be loaded, `catalog-invalid` when it is not valid UTF-8, not JSON or not a valid catalog; column `catalogs.error_code`). A game's `name` and `description` in the catalog are a text or an object with one text per language (`{ "de": "Dorfladen", "en": "Village shop" }`, keys are language codes, lengths as for a text); the server passes them on unchanged. A removed catalog does not take its games with it: afterwards they are listed "without catalog" ("ohne Katalog") and get no updates. Without a catalog, the admin view suggests the Gamehearth catalog (`suggestedCatalog` in `src/catalogs.ts`).

**Addresses.** Catalogs and packages come only over `https`; `http` works only for `localhost` and loopback addresses (tests, development), and a package over `http` only from a catalog that is itself served over `http` on localhost. A username or password in the address is forbidden. The server follows redirects at most five times and only to `https` (GitHub releases redirect). Timeouts: 30 seconds for a catalog, 5 minutes for a package.

**Installing.** For a version from a catalog, the server downloads the package (at most as large as stated in the catalog and 60 MB) and requires exactly the size and SHA-256 from the catalog. Then it checks it like `inspectPackage` in the dev tool: strict ZIP, only allowed files, manifest including the SDK range, limits for the client (5,000 files, 50 MB) and the reducer (5 MB), `id` and `version` as in the catalog. It writes the build to a temporary folder and renames it, loads `game.mjs` into the sandbox as a test and plays one bot match there with the smallest and one with the largest allowed player count (random legal moves with placeholders filled by random values, at most 300 moves, at most 30 seconds, options at their defaults). Single-player games without a reducer (`mode: "single"`, `server: false`) have no `game.mjs`; for them, sandbox and trial match are skipped. Only when everything works does the build become current (table `installed_games`). Only one installation runs at a time (`install-busy`); while it runs, games and catalogs cannot be removed either. The server replaces a game that is already installed from another catalog only with `replace: true` (`other-catalog`). It rejects a version that needs a newer SDK (`incompatible`); the admin view shows it grayed out.

**Builds.** Every installed build lives under `DATA_DIR/builds/<id>/<version>+<hash>/` with `manifest.json`, `game.mjs` (not for single-player games without a reducer) and `client/`, exactly as in the package. The hash covers manifest, code and all client files; the same package therefore always yields the same build. When loading, the server checks the hash; a damaged build (for example after a crash) counts as not installed, is listed as "damaged" ("beschädigt") in the admin view and is repaired on the next installation. The server process itself runs no game code, not even when installing. Builds from step 4 without a client folder count as damaged since step 5; rooms on them can no longer be entered.

**Updates and older versions.** The server sorts the versions of a catalog in descending order, regardless of the order the file lists them in. If there is a newer version that fits the SDK, the admin view shows "Update to …" ("Update auf …"); it is installed only on click. An older version can be installed the same way. Running matches and finished rooms stay on their build; lobbies move to the new build right away, new rooms and new rounds take it anyway.

**Removing.** The game disappears from `/api/games` right away, its lobbies are closed (members get `room-closed`). Running matches play to the end; the room reports `installed: false`, there is no new round (`game-unavailable`), and an abort closes the room instead of going to the lobby. Finished rooms can only be left and expire as usual.

**Cleanup.** After every installation and removal, and during the cleanup every ten minutes, the server deletes builds that are neither current nor used by a room, plus leftover temporary folders older than one hour. Installing and cleanup run one after the other, never at the same time; the cleanup reads which builds rooms use only when its turn comes. The admin view shows the storage per game, in total and the free space on the disk.

**Local games (`GAMES_DIR`).** Development only: if `GAMES_DIR` is set, the server builds every game in this folder from its sources at start (checks manifest and client like `check`, bundles with esbuild, only files from the game folder and the SDK, loads in the sandbox, no trial match). Local games are not remembered in the database, are called "local" ("lokal") in the admin view, can neither be updated nor removed there (`local-game`) and win over an installed game with the same `id`; the admin view names the shadowed build.

## Single player

Single-player games without a reducer run entirely in the browser and without a room (`POST /api/rooms` rejects them with `solo-game`). If an update turns a game with a reducer into one without, the server closes its lobbies as when removing it; running matches play to the end, after that there is no new round (`solo-game`), and the room reports `installed: false`. The server keeps one save per account and game and the best scores that the manifest declares under `stats` (tables `solo_saves` and `stats`, `ON DELETE CASCADE` on the user). Only accounts may read and write them (`account-required`).

- **Sync** (`POST /api/solo/<id>/sync`): A save replaces the stored one only if its time (`savedAt`, device clock) is later; the server sets times in the future to now. A best score replaces the stored one only if it is better according to the manifest's direction. The server skips names the manifest does not know and lists them in `ignored`, so a device with an old state does not get stuck. Saves up to 64 KB (request up to 96 KB), at most 60 syncs per minute and account.
- **Deleting.** A deleted save stays as a marker (`data` empty) with its time, even if the server never had a save; older saves that a device still sends afterwards thus stay out. Best scores, on the other hand, carry a deletion counter per stat (`generation`): deleting increments it, and a device sends with every value the counter it knew when the value was reached. The server skips values with a smaller counter, no matter how the devices' clocks run. The response names the deletion time of the save (`savedAt` with `save: null`) and the counters (`generations`), so the devices clear their copies.
- **Leaderboard.** Per stat the best 10 accounts (no guests, no locked accounts), equal values on the same rank, reached earlier first; if the own value is further down, it is added with its rank. All values come from the device (`source: client`).
- **Preload.** `GET /preload/<n>` (embedded only, `Sec-Fetch-Dest: document` yields 403) is a small page with a sandbox CSP whose only script is allowed by hash and fetches only files under `/games/`. Through it the UI loads the files of the single-player games into the HTTP cache (see [packages/client](../client/README.md#single-player-and-offline)); it is cached for a year so that it comes from the cache even offline. `<n>` is the version of the page; the UI names it.

## Profiles

Every account has one profile per game with `items`, `stats` and `flags` (contract in [packages/sdk](../sdk/README.md#profiles), decisions in `docs/design.md` under "Options and profiles from step 10"). Items and flags are stored as JSON in the table `profiles` (one row per account and game, with `revision`), stats in `stats`, the same table as the best scores of single-player games; values from games with a reducer carry `source: server`. Everything hangs on the user with `ON DELETE CASCADE`. The server checks the IDs against the catalog in the manifest of the room's build.

- **Reading.** Before every call of game code (start, move, realtime step, recompute) the server reads the current profiles of all seats including `revision` and passes them to the sandbox. Games without a catalog in the manifest get empty profiles without the server reading anything.
- **Writing.** The sandbox returns the profile changes of a call as a list. The server writes them in the same transaction as the move and checks whether the `revision` of each profile it read (and the assignment of the seats) has changed in the meantime. If it has, it discards the result and recomputes the move with the new profiles (at most five times) instead of rejecting it as `stale`; this way the game sees the current profile on every call. The server applies every change once more itself with the SDK's rules; if that fails, it is an incident like an error in the game code. If the profile does not change, it writes nothing and leaves the `revision` as it is.
- **Missing item.** If the game code rejects a move with `missing-item`, the server answers with `missing-item` (409), and nothing changes. The message to the client is always "Something this move needs is now missing from the profile; the move was not made", also for realtime inputs; the game code's message names seat and stock and could thus reveal another player's profile.
- **Recompute.** If a profile changes outside a match (a move in another room, a reset, a deletion in the admin view), the server recomputes the legal moves for every running turn-based match of the same game in which this account sits (`refreshMatch` in the sandbox, one room after another). If the moves change, the match's version goes up, the history gets an entry `refresh`, and "Your turn" ("Du bist dran") goes out as after a move. If the moves do not change, only the room's connections get an update with the new profile. Realtime matches do not need this, because every tick recomputes the moves.
- **Realtime.** A step with profile changes writes the changes and the match state in one transaction (instead of only after 10 seconds), so nothing counts twice after a crash; afterwards the connections get the whole room instead of a frame. If a profile it read has changed, the room recomputes the step up to three times, then it halts as on an error.
- **Guests** have an empty throwaway profile per match in `rooms.guest_profiles` (per seat); so do seats whose account was deleted. The start decides which seats have a throwaway profile: if a guest becomes an account in the middle of the match, or an account takes over their seats, the seat keeps the throwaway profile until the end of the match. A new round and an abort clear it.
- **History.** The profiles read are stored in `history.profiles`, but only if they changed since the last stored entry of this round (at the start, compared to all-empty profiles). For this the start writes an entry `start` with version 0 if a profile is not empty; `refresh` always stores the profiles.
- **Own profile in the room.** For members with a seat in a running or finished match, `room` contains `profile`, the own profile (for guests the throwaway profile). The server never sends other players' profiles.
- **Game page.** `GET /api/games/<id>` returns description, catalog, the own profile (`null` for guests) and, per stat with `better`, the leaderboard as for single-player games (top 10 of the accounts that are not locked, plus the own rank), for games with a reducer only values with `source: server`, for single-player games only `client` (`source` in the response). `POST /api/games/<id>/reset` resets the own profile: items and flags empty, every stat (from the manifest and every existing one) empty with an incremented deletion counter, so devices of single-player games do not bring back old best scores, including ones they never synced. At most 10 per minute and account.
- **Admin view.** Admins list the profiles of an installed game (only accounts with content), delete single entries or reset a whole profile; for a game that is not installed, the server answers with 404 without writing anything. If profiles contain an ID that the installed build no longer knows, `GET /api/admin/games` (`unknownIds` on the game), the list of profiles and the response to an installation name it; the installation happens anyway. The values stay in the profile; operations on them are errors in the game code.

### Trust

Whoever adds a catalog trusts it. The reducer does run in the sandbox, but a game's client runs in every player's browser: it sees everything this player sees, including the others' names, and can show anything within its frame. The CSP of the game files blocks network, foreign scripts and images; CSP does not govern WebRTC, though. The CSP therefore also lists `webrtc 'block'` for browsers that know the directive; Chromium does not know it and reports it in the console. The server does not serve game files as a top-level page at all (`Sec-Fetch-Dest: document` yields 403 with a sandbox CSP): there a game could show a fake login under the platform's address and send the input away by navigation. The checksum in the catalog protects against a swapped release asset, not against a tampered catalog; signatures come later.

## Rooms

A room has a code of six characters (without confusable characters like 0/O and 1/I), a lobby and a match.

1. Someone creates a room for a game and becomes host.
2. Others join with the code while the lobby is open and the room is not full.
3. In the lobby and after the end, every member can leave; in the lobby the host can remove members. If the host leaves, the member present the longest becomes host. If the last member leaves, the room is deleted.
4. If the game has options (`options` in the manifest), only the host sets them in the lobby (`set-option`); all members and TVs see description and choice. Only explicitly chosen values are stored (`rooms.options`); everything else is at the default of the respective build, even if a new build changes it. The choice stays across new rounds. When the server starts, lobbies of local games from `GAMES_DIR` move to their current build, as after an update from the catalog. If a room moves to a new build (lobby after an update, new round, abort), unknown options and values fall back to the default.
5. The host starts as soon as the player count fits the manifest. The match uses the game's current build; if it is no longer installed, the start fails with `game-unavailable`. The seats `p1`, `p2` … are assigned in join order, the seed comes from `crypto.randomBytes`, the options from the lobby, filled up with the build's default values. From the start on, every seat stays reserved, and the options are stored in the match (`match.options`).
6. Every move is first prechecked on the server's main thread, outside the sandbox, with the SDK's rules (match over, seat, `expectedVersion`, move among the stored legal moves). Only a valid move goes to `applyMove` in the sandbox. The result is written in a transaction, bound to the version number that was valid when reading; of two concurrent moves with the same `expectedVersion`, only one therefore counts. A move without `expectedVersion` is repeated with a fresh state after such a conflict (at most five times). At the start, the write transaction checks host, lobby, members, round number, build and options again; if any of these changed during `createMatch`, the start fails with `stale`.
7. When the match has a result, the room is finished. The host can then start a **new round**: the room goes back to the lobby with the same members (deleted seats are dropped) (seats are reassigned at the next start), the round number goes up, and the new match uses the game's current build. The host can **abort** a running match; that takes the same path, only without a result. Every finished or aborted match stays with its last state in the table `rounds` (a match that ended before this table existed is also stored there at the latest at the new round); a move that was still in the sandbox during an abort is not written into the new round (`stale`).

A room stays on the build a match was started with until the match ends, also across restarts and new builds. Lobbies that were never played in and where nothing has happened for 24 hours are removed at start and every ten minutes afterwards. Other rooms disappear when their last member leaves, an admin closes them or they lie around too long (see "Cleanup"), each together with their stored rounds.

**Members are users.** Every member points to an account or guest (`users`); a user sits in a room at most once and gets in from any device with their session. Only accounts create rooms; guests join via link, QR code or code. If a user is deleted (by the admin or because a guest expires), this acts like leaving in lobbies and finished rooms; in running matches their seat stays as deleted (`deleted: true` with an empty `name`; the UI shows its own text, "Deleted" or "Gelöscht") and is also visible in the result until the next round or until the match is aborted; "My rooms" ("Meine Räume") does not count it. The host is then always the member present the longest who still has a user; if none is left, the room disappears.

**Bots.** A game whose code exports `bot` (see [packages/sdk](../sdk/README.md#bots); the server asks the sandbox once per build) gets `bots: true` in `room.game`. Only then:

- In the lobby the host adds bots with `add-bot` (otherwise `not-host`, outside the lobby `not-in-lobby`, without `bot` `no-bots`, in a full room `room-full`). A bot is a member without a user (`members.bot` is its number, 1, 2, …, the lowest free one); the room view gives it `bot: <number>` and an empty `name`, and the UI names it per language. Bots count toward the player count and the room's size, the host removes them with `kick`, they stay across new rounds, and a room whose last person leaves is deleted with its bots. A bot from the lobby plays with an empty throwaway profile like a guest.
- In a running match a member hands their own seat to a bot with `hand-over` and their own member id; the host can also hand over the seat of a member without a connected device (otherwise `member-connected`). The member keeps the seat and the profile (`members.autopilot = 1`, `autopilot: true` in the view) until they take it back with `take-back` (otherwise `not-handed-over`); a new round or an abort ends it. While a bot plays for them, their own moves get `bot-playing`, and they get no "Your turn" push and no `yourTurn` in "My rooms".
- **Turn-based:** about a second after every change, the room asks the sandbox (`botMove`) for the move of the first bot seat that has moves, checks it against the stored legal moves and plays it like any move (history, profiles, pushes). If `bot` throws, picks an illegal move or the sandbox fails, the server takes a random legal move and logs the reason (`[Bots] Room …, seat …: …`, each reason once per room, at most 20). After every move it looks again, so several bot seats play one after another; a person's move in between makes the bot's choice stale, and it chooses again.
- **Realtime:** bot seats never count as missing; in every tick `stepMatch` gets them as `bots`, and the game's bot moves inside the tick. Problems are logged the same way, once per seat and reason.

Migration v13 (step 15) adds `members.bot` and `members.autopilot`; existing members are people without autopilot.

**Cleanup:** Besides the orphaned lobbies, finished rooms and lobbies after a round disappear after `FINISHED_ROOM_DAYS` without activity, running matches after `IDLE_GAME_DAYS` without a move and guests after `GUEST_DAYS` without activity. "My rooms" shows the date in the last week before. The server cleans up at start and every ten minutes.

## Realtime

Games with `"mode": "realtime"` do not run move by move, but at a fixed tick rate of 20 ticks per second (see `tick` in [packages/sdk](../sdk/README.md#realtime)).

- **In memory.** A running realtime match lives in the server's memory. The server writes it to SQLite at the start, every 10 seconds, on every pause, on an error and at the end; single ticks and inputs do not go into the history (`history`). After a restart the server loads running realtime matches paused and continues them as soon as everyone is back; at most 10 seconds are lost.
- **Inputs until the tick.** A `move` goes into a queue of the room, without a check of `expectedVersion`. In the next tick the sandbox computes all inputs in order and then `tick` in one call (`stepMatch`). The answer to `move` (`ack` or an error like `illegal-move`) comes only afterwards. Per seat at most 4 inputs wait for the next tick; a fifth pushes out the oldest (which gets `too-many-inputs`), so a release is never lost. Per tick the sandbox processes at most 64.
- **Tick rate.** The tick loop checks every 10 ms whether a tick is due. If a tick comes too late because the machine was busy, it catches up to 200 ms of backlog; anything beyond that is dropped. This way game time runs with the clock without catching up in fast motion after a hang.
- **Inputs during a pause.** During a pause and after an error, the room remembers the last input per seat, acknowledges it right away and applies it in the first tick afterwards; the same goes for inputs that were still waiting for the tick when pausing.
- **Snapshots per tick.** After every tick each connection gets a light `frame` with its snapshot instead of the whole room. If a connection lags behind (more than 64 KB unsent), the server skips frames for it instead of disconnecting it.
- **Delta frames.** A client that announces them (`deltas: true` in `hello` or `screen`) gets only what changed since the snapshot the server last handed to its socket: `{ "type": "frame", "base", "delta" }`, with the `version` of that snapshot as `base` and the operations of `jsonDelta` from [packages/sdk](../sdk/README.md#for-the-platform-gamehearthsdkplatform); growing texts and lists come only with the appended part. A drawing of 10 KB and more that grows by 40 characters per tick thus costs about 260 bytes per frame instead of the whole snapshot. The whole snapshot (`{ "type": "frame", "snapshot" }`) comes when there is no such snapshot yet, after `resync`, and whenever the delta would not be smaller. `room` and `screen-room` carry the snapshot as well and count as handed over (for example after a tick that wrote a profile, which sends `room` instead of a frame); a skipped frame does not, so the next delta covers the skipped ticks. The server computes each delta once per tick, seat and base, so the connections of a seat and the TVs share it. Clients without the flag, such as an old cached UI, keep getting whole snapshots.
- **Countdown and pause.** After the start and after every pause, the room counts down 3 seconds; inputs during this time count for the first tick. It pauses when a seat has no visible connection (a locked phone reports `visibility: false`; a phone without network is noticed through a ping every 5 seconds) or a game with a required TV (role `screen` without `"optional": true`) has no connected TV, each after a 2-second grace period; when everyone is back, the countdown starts. The host can also pause and resume. No ticks run during a pause.
- **Errors.** If a tick fails because of a timeout or too much memory, the room recomputes it once on a fresh sandbox; a single outlier, for example because the machine was busy for a moment, thus halts no match and does not count as an abort of the build. If the tick broke the hard limit and caused a worker restart, the room does not recompute it, so an infinite loop does not block the worker a second time. If it fails again or on the game code, the room halts at the last valid state (`halted`) and names the incident number; the message is in the log. The host can abort or try again with `resume`; repeated aborts quarantine the build as with turn-based games.
- **Playing on.** A game with `"away": "play-on"` in the manifest does not pause for a missing seat: after the same 2-second grace period the seat counts as away, `stepMatch` passes the away seats as `away` (the game reads them in `ctx.away`), and whoever comes back is present in the next tick. The match pauses only when every seat played by a person is away, or when a required TV is missing. `live.awaySeats` lists the away seats; `missingSeats` stays empty while the match plays on.
- **Start.** A game with role `screen` starts only when at least one paired TV is connected (otherwise `screen-missing`). If the manifest marks the TV `"optional": true`, the match starts without a TV and never pauses for one; paired TVs show it as usual. There is no "Your turn" in realtime, "Match is over" ("Partie ist vorbei") as usual.

For running realtime matches, `room` also contains `live`: `state` (`countdown`, `running`, `paused`, `halted`), for `countdown` the remaining `remainingMs`, the missing seats (`missingSeats`), for games that play on the away seats (`awaySeats`), `screenMissing`, `byHost` and after an error `incident`.

## TVs

A TV is not a member and needs no account. It has its own device cookie (`gh-tv`, behind HTTPS `__Host-gh-tv`, only as a hash in the table `screens`) and is paired with exactly one room by code:

1. The page `/tv` gets the cookie via `POST /api/tv` and sends `{ "type": "screen" }` over the WebSocket.
2. If the device is not paired yet, the server answers with `{ "type": "pairing", "code", "expiresAt", "expiresInMs" }` (the remaining time, so a wrong clock on the TV does not matter): 8 characters from the alphabet of the room codes, shown as `ABCD-EFGH`, valid for 10 minutes, only in memory and hashed with a key that does not survive a restart.
3. A member enters the code (`POST /api/rooms/<code>/screens`). The server pairs the device, sends it the room and the members an update. A device belongs to at most one room; a new pairing moves it.

A member can also turn their own device into the TV directly (`POST /api/rooms/<code>/screens/self`), for example a laptop connected to the TV; this sets the device cookie without a code. If the session on this device ends later, the TV connection stays, because a TV needs no session.

Pairing works only in rooms whose game has the role `screen`, optional or not (otherwise `no-screen-role`), at most 4 TVs per room (`too-many-screens`). The host removes a TV with `remove-screen`; the TV then gets a code again. The pairing holds across new rounds and ends with the room and after 24 hours without a connection.

A TV gets `{ "type": "screen-room", "room": … }`: code, game, status, round, player count, members with connection status, the room's TVs (`screens`, `screen` is the own one), `installed`, `live` and as snapshot only the SDK's `screenSnapshot` (`players`, `public`, `version`, `tick`, `result`). It never gets seats, private areas, moves or `secret`.

**Migration from step 5:** The database migration turns every old member into a guest with their name and keeps room, seat and host. It keeps the old token hash (`members.legacy_token_hash`). The UI sends the room tokens stored on the device once to `POST /api/claim`; the server attaches the seats to the device's session (or to the first old guest if the device has none yet) and deletes the hash. Guests that are not claimed expire after `GUEST_DAYS`.

**Prepared for profiles:** The history (`history`, counted per round) has a column `kind` (so far only `move`, later also `refresh` when legal moves change because of a profile) and a column for profile snapshots. Every move is already its own transaction with a version check (see "Game data, options and profiles" in `docs/design.md`).

## Accounts, guests and sessions

- **User:** Accounts have a username (unique, case-insensitive, 3–32 characters of letters, digits, `.`, `_`, `-`), a display name (1–24 characters) and a role (`player` or `admin`). Guests have only a display name and start on one device; with a transfer code they get onto more (see below). Accounts and guests can store the language of the UI (`users.language`, see [Languages](#languages)).
- **Passwords:** at least 10, at most 200 characters, stored with scrypt (`N=2^16, r=8, p=2`, about 250 ms) including the parameters; if the parameters change, the hash is recomputed at the next login. The table `credentials` has a kind (`password`), so passkeys can be added later.
- **Session:** random ID in the cookie `gh-session` (behind HTTPS `__Host-gh-session` with `Secure`), always `HttpOnly` and `SameSite=Lax`; the database stores only the SHA-256 hash. Account sessions last a sliding 90 days, guest sessions as long as the guest. Locking, deleting, changing the password and logging out end sessions; open WebSockets of these sessions get `signed-out` and are closed.
- **CSRF:** Every `POST` needs `content-type: application/json` and must not carry a foreign `Origin` or a foreign `Sec-Fetch-Site`; the same applies to opening a WebSocket. Without `Origin` (for example `curl`) it goes through.
- **Links** (setup, invite, reset) are valid once; only the hash is stored. The token is in the fragment (`/invite#…`), so it never ends up in a request or a proxy log; the UI sends it in the body. Open links expire when their creator is deleted, locked or demoted from admin to player. A reset link also expires when a new one is created, the password is changed or the account is locked. Only the admin view sees an invite's note, not the invited person.
- **Guest becomes account:** If a guest opens an invite, they become an account with the same rooms. If an existing account logs in on a device with a guest, or redeems a transfer code of another user there, the new session remembers the guest; `GET /api/me` then returns `adopt` with their rooms, and `POST /api/me/adopt` takes over the seats (except in rooms where the target already sits) or leaves the guest alone. This also applies if the target is itself a guest. `adopt` separates `rooms` (move) and `duplicates` (rooms where the target already sits; the duplicate seat is dropped, in running matches it stays as "Deleted"). If the guest is still logged in on another device, there is no `adopt`, and the guest stays.
- **Transfer code:** `POST /api/me/transfer` creates a code of 8 characters for the logged-in user (alphabet of the room codes, shown as `ABCD-EFGH`), valid for 10 minutes and once; admins get none (`forbidden`), and a code created earlier by a user who has since been promoted is then no longer valid either. Only an HMAC with a key that lives only in memory is stored (a restart invalidates open codes, a backup reveals none), in `transfer_codes`, with `session_id` and `ON DELETE CASCADE`: logging out, locking, resetting the password and deleting invalidate it; a new code replaces the old one. `POST /api/transfer` redeems it (case, spaces and hyphen do not matter) and creates a new session for the same user; the session that created the code stays. A session the device already had ends as on login. This is meant mainly for the installed app on the iPhone, which is logged in separately from Safari.
- **Devices of a guest:** A guest has no password. They can therefore only log out devices that were added after their own (higher session number): their own and older ones answer `forbidden`, `end-all` ends only the newer ones. This way a stolen code does not lock out the original device. If a guest accepts an invite, their sessions on all other devices end.

## HTTP

| Request | Response |
|---|---|
| `GET /api/health` | `{ "ok": true }` |
| `GET /api/games` | installed games (from catalogs and local) with `id`, `name`, `version`, `mode`, `players`, `roles`, `description` (if in the manifest), `languages` and `cover` (if in the manifest, see [Languages](#languages)); single-player games without a reducer also with `solo: true`, `build` and `stats` |
| `GET /api/games/<id>` | game page `{ game, profile, boards, source }`: `game` with description, `languages`, `cover`, player count, roles, `solo` and catalog (`items`, `stats`, `flags`), the own profile (`null` for guests) and the leaderboards per stat with `better`; only with a session |
| `POST /api/games/<id>/reset` | resets the own profile, response as for `GET`; accounts only |
| `GET /api/solo/<id>` | `{ game, save, savedAt, best, generations, boards, ignored }`: own save (`{ data, savedAt }` or `null`), own best scores, deletion counter per stat and leaderboard per stat (`rank`, `name`, `value`, `you`); accounts only, single-player games only (`not-solo`) |
| `POST /api/solo/<id>/sync` with `{ save?: { data, savedAt } \| { deleted: true, savedAt }, best?: { <stat>: { value, at, generation } } }` | stores the newer save and the better best scores, response as for `GET` |
| `POST /api/solo/<id>/delete` with `{ what: "save" \| "best" }` | deletes the own save or all own best scores, response as for `GET` |
| `GET /api/solo/<id>/files` | `{ build, client, files }`: files of the current build for preloading |
| `GET /api/me` | `{ "user"?, "adopt"? }` for the session of the cookie; clears an invalid cookie. `user` is `{ id, kind, username?, name, role, language, theme }` with `language` `"en"`, `"de"` or `null` (not chosen, the device decides) and `theme` `"neon"`, `"crt"`, `"front"` or `null` (the default); every response with `user` has this shape |
| `POST /api/login` with `{ "username", "password" }` | `{ "user" }` and a new cookie |
| `POST /api/logout` | ends the session |
| `GET /api/me/rooms` | `{ "rooms" }` with code, `gameId`, game (the raw name), `languages` and `cover` of the game's current build (if any), status, round, member count, host, `yourTurn`, `muted`, `screen` (the game has a TV) and `expiresAt` |
| `POST /api/me/name` with `{ "name" }` | change display name (also for guests) |
| `POST /api/me/language` with `{ "language": "en" \| "de" \| null }` | `{ "user" }`: store the language of the UI for this user (also for guests); `null` lets the device decide again; other values yield 400 `invalid-language`; rate-limited like the push settings |
| `POST /api/me/theme` with `{ "theme": "neon" \| "crt" \| "front" \| null }` | `{ "user" }`: store the theme of the UI for this user (also for guests); `null` is the default (neon hall); other values yield 400 `invalid-theme`; shares the rate limit of the language |
| `POST /api/me/password` with `{ "current", "password" }` | change password; ends all other sessions |
| `GET /api/me/sessions` | devices with `id`, `browser` and `system` (each only if recognized, for example `Firefox` and `Windows`, neither for an unknown device; the UI builds the label), times, `current` and `push` (push on for this device) |
| `GET /api/me/push` | `{ "publicKey", "enabled" }`: the server's VAPID key and whether this session has a subscription |
| `POST /api/me/push` with `{ "subscription", "language"? }` | store this device's subscription (`PushSubscription.toJSON()`) and the language of the UI on this device (`"en"` or `"de"`, otherwise 400 `invalid-language`), replaces an older one of the same session; sending it again changes the device's language |
| `POST /api/me/push/renew` with `{ "oldEndpoint", "subscription" }` | enter a subscription renewed by the browser (the service worker on `pushsubscriptionchange`); `{ "renewed": false }` if this session has no subscription with `oldEndpoint` |
| `POST /api/me/push/off` | delete this device's subscription |
| `POST /api/me/push/test` | test message to this device, at most one per minute |
| `POST /api/me/sessions/<id>/end`, `POST /api/me/sessions/end-all` | log out one device or all (guests: only those added later, see above) |
| `POST /api/me/transfer` | `{ "code", "expiresAt" }`: transfer code for another device (not for admins) |
| `POST /api/transfer` with `{ "code" }` | `{ "user" }` and a new cookie; invalid, expired or used codes yield 404 `unknown-code` |
| `POST /api/me/adopt` with `{ "take" }` | take over a guest's seats or not (see above) |
| `POST /api/rooms` with `{ "game" }` | `201 { "code" }`, accounts only |
| `POST /api/rooms/<code>/join` with `{ "name"? }` | `201 { "code" }`; without a cookie the server creates a guest with this name and sets the cookie |
| `POST /api/rooms/<code>/mute` with `{ "muted" }` | mute the room for this user or not (applies on all devices) |
| `POST /api/tv` | sets a TV's device cookie if it is missing; without login |
| `POST /api/rooms/<code>/screens` with `{ "code" }` | `201 { "id" }`: pairs the TV with this code with the room (members only); invalid or expired codes yield 404 `unknown-code` and count as a failed attempt |
| `POST /api/rooms/<code>/screens/self` | `201 { "id" }`: makes this device the room's TV and sets the device cookie |
| `POST /api/claim` with `{ "tokens" }` | exchange room tokens from step 5 (at most 30) |
| `POST /api/links/inspect` with `{ "token", "kind" }` | kind, role, expiry and suggestions of a link (`setup`, `invite`, `reset`) |
| `POST /api/invites/accept` with `{ "token", "username", "name", "password" }` | create an account (or convert a guest), `201 { "user", "upgraded" }` and cookie |
| `POST /api/reset` with `{ "token", "password" }` | set the password, ends all sessions of the account |

Admins only (`/api/admin/…`): `GET users` (with number of rooms), `POST users/<id>` with `role`, `locked` or `username`, `POST users/<id>/reset` (reset link), `POST users/<id>/delete`, `GET invites`, `POST invites` with `role`, `note`, `username`, `name`, `POST invites/<id>/revoke`, `GET rooms` (`game` is the raw name), `POST rooms/<code>/close`, `GET builds` (quarantined builds with `reason` in English and `hardAborts`, `softAborts`, `windowMinutes` for a translated sentence), `GET backups`, `POST backups` (back up now). The last admin who is not locked cannot be demoted, locked or deleted (`last-admin`).

Games and catalogs (see [Games and catalogs](#games-and-catalogs)):

| Request | Response |
|---|---|
| `GET /api/admin/games` | `{ games, catalogs, offers, storage, suggested, enabled }`: installed games with source, catalog, rooms (`lobby`, `running`, `finished`), size, `broken`, `shadowed`, `unknownIds`, `languages` and `cover`; catalogs with state, last error and `errorCode`; all games of the catalogs with versions (`compatible`), installation state and `update`; storage in total and free; suggestion of the Gamehearth catalog (`{ name: "Gamehearth", url }`, the catalog's own name) as long as none is entered |
| `POST /api/admin/catalogs` with `{ url, trust: true }` | `201 { catalog }`; without `trust` `trust-required` |
| `POST /api/admin/catalogs/<id>/refresh` | `{ catalog }`, with `error` on an error |
| `POST /api/admin/catalogs/<id>/delete` | `{ games }`: games that stay installed without a catalog |
| `POST /api/admin/games/install` with `{ catalog, game, version, replace? }` | `{ build, unknownIds? }`; lobbies move to the new build; `unknownIds` names IDs in profiles that the new build no longer knows |
| `GET /api/admin/games/<id>/profiles` | `{ game, profiles, unknownIds }`: catalog, profiles of the accounts with content (`user`, `name`, `profile`, `updatedAt`) and unknown IDs per section |
| `POST /api/admin/games/<id>/profiles/<user>/delete` with `{ section, id }` | deletes one entry (`items`, `stats` or `flags`), response as for `GET`; it reports a missing entry with 404 `unknown-entry` |
| `POST /api/admin/games/<id>/profiles/<user>/reset` | resets the whole profile, response as for `GET` |
| `POST /api/admin/games/<id>/remove` | `{ closed, remaining }`: closed lobbies and rooms still on the game |
| `GET /api/admin/games/<id>/boards` | `{ boards }`: per stat the best 100 accounts with `user`, `name`, `value`, `at` |
| `POST /api/admin/games/<id>/boards` with `{ user, stat }` | deletes this best score (increments the deletion counter, see [Single player](#single-player)), response as for `GET`; it reports an unknown account with 404 `unknown-user` |

All other `GET` and `HEAD` requests serve the UI and the games:

| Path | Content | Headers |
|---|---|---|
| `/games/<id>/<version>+<hash>/…` | files from the client folder of this build, `/` is `index.html`; only files that were checked when installing | CSP with `sandbox allow-scripts`, sources only from this build folder and `webrtc 'block'`, `Access-Control-Allow-Origin: *`, one year cache |
| `/preload/<n>` | page for preloading the single-player games | sandbox CSP, script only by hash, requests only under `/games/`, one year cache |
| `/assets/…` | hashed files of the UI | one year cache |
| other paths with a file extension (`/sw.js`, `/manifest.webmanifest`, icons) | files from `CLIENT_DIR` | `no-cache` |
| all other paths (`/`, `/r/ABC234`) | `index.html` of the UI | strict CSP (only own scripts, `frame-ancestors 'none'`), `no-cache` |

If the browser loads a game file as a top-level page (`Sec-Fetch-Dest: document`, for example after a click on a link to it), the server answers with 403 and a hint, also with a sandbox CSP; the hint is German or English by `Accept-Language` (English if neither is asked for), with `Content-Language` and `Vary: Accept-Language`. The same goes for `/preload/<n>`. Older browsers without this header get the file; the CSP forces them into the sandbox too, so the game can never read the platform's tokens. The server takes the host for the sources from the request (only valid host names, otherwise 400), the scheme behind a trusted proxy from `X-Forwarded-Proto`. For an IPv6 address as host it puts `'self'` there, because CSP sources know no IPv6 hosts; the restriction to the build folder is then dropped. Paths with `..`, encoded slashes or control characters are rejected.

Errors come as `{ "code", "message" }`; the `message` is an English developer text, the UI shows its own text per `code`. 400 for invalid input (`invalid-language` for a language other than `en`, `de` or `null`), 401 when not logged in or on a wrong login, 403 without permission (`account-required`, `not-member`, `not-admin`, `forbidden`, `account-locked`, `signed-in`, `last-admin`), 404 for anything unknown (also invalid links and transfer codes, unknown catalogs and versions), 409 for a full or already started room, a move for which an item is missing (`missing-item`), a room for a single-player game (`solo-game`), single-player requests for a game with a reducer (`not-solo`), a taken username, too many rooms, a test message without a subscription (`push-off`) and for conflicts in game management (`catalog-exists`, `other-catalog`, `install-busy`, `local-game`, `incompatible`), 502 if a catalog or package cannot be loaded (`catalog-unavailable`) or a catalog is invalid (`catalog-invalid`), 400 for invalid packages (`package-invalid`, `wrong-package`, `probe-failed`), 429 for rate limiting (with `Retry-After` where known), 500 for internal errors (which end up in the log with a stack trace). Requests are limited to 4 KB, syncs of single-player games to 96 KB.

## WebSocket

Connection to `/ws`. Who is connected is determined by the session cookie when the connection opens, for TVs by the device cookie; a foreign `Origin` is rejected. Without `hello` (or `screen`) within 10 seconds, the server closes the connection. Messages are limited to 64 KB.

**From the client:**

| Message | Meaning |
|---|---|
| `{ "type": "hello", "room", "visible"?, "deltas"? }` | enter a room (without a session `not-signed-in`, without membership `not-member`); another `hello` on the same connection only sends the current state again. `visible` says whether the app is currently visible; without a value it counts as visible. `deltas: true` says that the client applies delta frames (see [Realtime](#realtime)); without it every frame carries the whole snapshot |
| `{ "type": "visibility", "visible" }` | the app became visible or went to the background; as long as one of a member's connections in the room is visible, the member gets no push |
| `{ "type": "start" }` | start the match (host only) |
| `{ "type": "set-option", "name", "value" }` | set a game option in the lobby (host only); a value the manifest does not provide fails with `invalid-option`, outside the lobby with `already-started` |
| `{ "type": "leave" }` | leave the lobby |
| `{ "type": "kick", "member": <id> }` | remove a member or a bot from the lobby (host only) |
| `{ "type": "add-bot" }` | add a bot to the lobby (host only, games with `bot`; see [Bots](#rooms)) |
| `{ "type": "hand-over", "member": <id> }` | let a bot play a seat in the running match: your own, or as host the seat of a member without a connected device |
| `{ "type": "take-back" }` | take your own seat back from the bot |
| `{ "type": "move", "action", "expectedVersion" }` | make a move; `expectedVersion` is the `version` of the last snapshot |
| `{ "type": "new-round" }` | back to the lobby after the end (host only) |
| `{ "type": "abort" }` | abort the running match without a result and go back to the lobby (host only) |
| `{ "type": "pause" }`, `{ "type": "resume" }` | pause or resume a realtime match, also after an error (host only) |
| `{ "type": "remove-screen", "screen": <id> }` | remove a TV from the room (host only) |
| `{ "type": "screen", "deltas"? }` | TVs only: get a code for pairing or, if paired, enter the room (without a device cookie `no-device`); `deltas` as with `hello` |
| `{ "type": "resync" }` | the client could not apply a delta frame (another `base` than its snapshot, or the delta does not fit); the next frame carries the whole snapshot. Members and TVs |

Every message may carry an `id` (whole number from 0). Then the server confirms success with `{ "type": "ack", "id" }`, and only after the room's new state has gone to all connections; the `id` is also in the error. This way the UI matches answers to its moves. There is no `ack` for `hello`; the answer is the room's state.

**From the server:**

| Message | Meaning |
|---|---|
| `{ "type": "room", "room": … }` | complete state of the room for exactly this member, after every change at most once per change |
| `{ "type": "ack", "id" }` | acknowledgement of a message with `id` |
| `{ "type": "error", "code", "message", "id"? }` | error, only to the sender |
| `{ "type": "frame", "snapshot" }`, `{ "type": "frame", "base", "delta" }` | after every tick of a realtime match the new snapshot of this connection, or for clients with `deltas` the changes since the snapshot with the version `base` (see [Realtime](#realtime)) |
| `{ "type": "screen-room", "room": … }`, `{ "type": "pairing", "code", "expiresAt" }` | only to TVs, see [TVs](#tvs) |

`room` contains code, game and build (with `client`, the address of this build's client folder, plus `mode`, the roles, `languages` and `cover` from the manifest, and `screenOptional: true` if the TV is optional), the paired TVs (`screens` with `id` and `connected`), status (`lobby`, `running`, `finished`), round number (`round`), player count, members with `id`, name, seat, host, `guest`, `deleted` and connection status, `muted` (only for oneself), `canStart`, `installed` (whether the game is still installed), for games with options `options` (`spec` from the manifest and `values`: in the lobby the choice, during and after the match the options of the match) and during the match the `snapshot` of the own seat from the SDK including `profile`, the own profile (see [Profiles](#profiles)). Other hands, other players' profiles, `secret`, seed and tokens do not leave the server.

**Errors in the game code** reach the client only as a general message with an incident number ("incident 3fa2c91b"). The actual message with stack trace is only in the server log, because it can contain hidden values (for example "No card for pik-10"). This also applies to sandbox aborts (time limit, memory, crash). The room stays in the last valid state and plays on with a newly set up sandbox. If a build is quarantined (see [Sandbox](#sandbox)), every further move reports `game-unavailable`.

If the host **removes** a member, a room is closed or a session ends, the affected connections get the error `removed`, `room-closed` or `signed-out` respectively and are closed with code 4000. If someone changes their display name, all their rooms get an update.

Error codes: `bad-url`, `catalog-exists`, `catalog-unavailable`, `catalog-invalid`, `invalid-language`, `unknown-catalog`, `unknown-version`, `incompatible`, `other-catalog`, `install-busy`, `trust-required`, `package-invalid`, `wrong-package`, `probe-failed`, `local-game`, `unknown-code`, `bad-subscription`, `push-host-not-allowed`, `push-off`, `unknown-game`, `game-unavailable`, `unknown-room`, `unknown-user`, `not-member`, `account-required`, `too-many-rooms`, `not-signed-in`, `signed-out`, `unknown-member`, `room-full`, `already-started`, `not-host`, `wrong-player-count`, `not-running`, `not-finished`, `game-over`, `stale`, `not-your-turn`, `illegal-move`, `game-error`, `paused`, `too-many-inputs`, `screen-missing`, `no-screen-role`, `too-many-screens`, `unknown-screen`, `solo-game`, `invalid-option`, `not-solo`, `invalid-stat`, `no-device`, `bad-message`, `not-joined`, `not-found`, `rate-limited`, `too-many-connections`, `removed`, `room-closed`, `server-error`.

## Protection against abuse

| Limit | Default |
|---|---|
| new rooms per address | 20 per minute |
| joins, token exchanges and new transfer codes per address | 30 per minute |
| unknown rooms (join, `hello`), invalid links and invalid transfer codes per address | 30 per minute, then `rate-limited` |
| failed logins and password changes per address | 10 in 15 minutes, then `rate-limited`, even with the correct password; an attempt counts before the password is checked and is refunded on success, so concurrent requests do not get around the limit |
| failed logins per username and address | from 5 on a growing wait (30 s, 1, 2, 4, 8 minutes, at most 15); from another address the owner still gets in |
| failed logins per username across all addresses | 50 per hour, then `login-throttled` for everyone until the end of the hour; only distributed guessing can thus lock out an account for a while |
| password hashes at the same time | 2; more wait, so logins do not block the remaining threads for files |
| WebSocket connections per address | 50; the server closes connections without a session and without a TV's device cookie right away with `not-signed-in` |
| open rooms as host / rooms per user | 20 / 50 (`MAX_HOSTED_ROOMS`, `MAX_ROOMS_PER_USER`) |
| WebSocket connections in total / per room / per member | 1,000 / 64 / 4 |
| unsent data per connection | 1 MB, above that the connection is dropped |
| heartbeat | ping every 30 seconds, in rooms with a running realtime match every 5; whoever does not answer by the next ping is disconnected and counts as not connected |
| moves per member | 120 per minute across all their connections, then `rate-limited`; in realtime 30 inputs per second |
| invalid TV codes and unknown rooms when pairing, per address | count like invalid links (30 per minute) |
| TVs waiting for pairing | 4 per address and 100 in total, plus 30 requests for a code per minute and address; at most 10,000 open codes, after that a new device gets no code until old ones expire (`too-many-connections`) |
| turning push on and off, renewing, test message, muting | 20 per minute and address; test message also one per minute and device |
| changing the language or the theme (`POST /api/me/language`, `POST /api/me/theme`) | 20 per minute and address, together |

Changes to a room are merged per event loop iteration, so every member gets at most one update per change.

## Sandbox

Game code runs in QuickJS (bellard/quickjs via `quickjs-emscripten` 0.32.0, WebAssembly). The server shares the core (prelude, guest runner, sandbox class, output check) with `check`; it lives in [`gamehearth/sandbox`](../devtool/README.md#sandbox). Here in the server are the sandbox worker and its supervision (`src/sandbox/`).

| Limit | Value |
|---|---|
| time per call (`createMatch`, `applyMove`) | 100 ms, measured by QuickJS and additionally on the total duration |
| time when loading a game | 1 s |
| memory per sandbox | own WebAssembly module with 16 MB base load plus at most 32 MB; from 8 MB growth on, the sandbox is set up anew |
| stack | 256 KB for QuickJS in a worker with a 4 MB stack |
| output of a call | at most 256 KB in UTF-8 and 20,000 nodes in state and moves, state at most 100 levels deep |
| hard limit in the worker | 500 ms per call, 3 s when loading |
| quarantine of a build | after 3 hard or 10 soft aborts within 10 minutes, until the restart |
| sandbox without a move | discarded after 10 minutes |
| sandboxes at the same time | at most 64; above that, the one unused the longest is discarded |

- **One sandbox per room.** It is created on the room's first game code call and stays for all further moves. It is set up anew after a timeout, memory growth, invalid output, a crash, a worker restart and after 10 minutes without a move. Because every call brings the whole match as JSON, nothing is lost.
- **Prelude.** Before a game loads, the sandbox blocks `Math.random`, the clock (`Date()`, `Date.now`, `new Date()` without an argument, also via `Date.prototype.constructor` or the property descriptor), everything that depends on the time zone (date methods with local time like `getHours`, `Date.parse`, `new Date` with text or several arguments), `eval` and all function constructors, and removes `WeakRef`, `FinalizationRegistry` and `performance`. `instanceof Function` and `Function.prototype` keep working. `require`, `process`, `fetch`, files, timers and network do not exist in QuickJS anyway.
- **The server does not trust the sandbox.** Game code can defeat every check of the SDK in the guest. The main thread therefore checks size in bytes, number of nodes, depth, `format`, `seed`, `players`, `version`, the seats in `state.players` and `moves`, the size of each move and `result`, and accepts only these fields. The node limit ensures that the main thread does not compute long on a state; it computes the snapshot for a member only once per change, even with several connections.
- **Sandbox worker.** All sandboxes run in one worker thread, so the main thread stays free for WebSockets and other rooms. QuickJS's time limit is only cooperative; expensive built-in functions like `sort()` on large arrays run without a check. The worker therefore writes the number of each request, the phase (call or load) and the start time into a `SharedArrayBuffer` before the request. The start time is measured by a process-wide monotonic clock, so changes to the system clock shift nothing. If a request exceeds the hard limit of its phase or the worker crashes, the main thread terminates the worker and restarts it, reports an error to the running request and resends all other waiting requests exactly once. A hard abort holds up all rooms for the duration of the limit. Every restart is in the log with its reason; after more than 5 restarts in 10 seconds, the main thread waits with a growing pause before trying again.
- **Quarantine.** A build that was aborted three times hard or ten times soft (time limit, memory, invalid output, crash, load error) within 10 minutes is quarantined until the server restarts; this is in the log. New rooms for this build cannot be created or entered (`game-unavailable`); existing ones stay visible.
- **Built at runtime.** The server bundles the guest runner and the worker script with esbuild at start from the sources of the dev tool and the server; both must therefore be next to `dist/`, as the games already are today. The worker script lands in a temporary folder and includes the QuickJS packages via absolute paths; if it is missing at a restart (for example because the temporary folder was cleaned up), the server writes it again from memory.

## Web push

"Your turn" ("Du bist dran") and "Match is over" ("Partie ist vorbei") as notifications, even when the app is closed (decisions in `docs/design.md` under "Web push").

- **When.** After every move and at the start, the room compares the legal moves before and after. Whoever had none and now has some gets "Your turn"; when the match ends, all members with a seat get "Match is over". Abort, new round and lobby trigger nothing. Muted members are left out.
- **Not for whoever is watching.** If a member has a connection in the room that reports `visible`, they get no push, not even on other devices. A connection without a value counts as visible, so an old, still cached UI does not trigger anything twice.
- **Merged.** Per user and room at most one push goes out every 30 seconds. Whatever comes up in between waits; the newest message wins. Before every sending, also before a second attempt, the server checks again whether it is still due (still their turn, match still over, not muted, nobody watching) and whether something newer already went out for user and room.
- **Subscription.** Table `push_subscriptions` with address (`endpoint`), keys (`p256dh`, `auth`), the origin of the page and the language of the UI on this device (`language`, may be empty), on `session_id` with `ON DELETE CASCADE`. Logging out, locking, deleting, resetting the password and the expiry of a session thus remove the subscription too. A session has at most one subscription, an address belongs to at most one session, a user has at most 10 (a new one pushes out the oldest).
- **Only known services.** Accepted are `https` addresses of `fcm.googleapis.com`, `*.push.services.mozilla.com`, `*.push.apple.com` and `*.notify.windows.com` plus the entries from `PUSH_HOSTS`. The server follows no redirects. This way nobody can make the server send requests into the home network.
- **Encryption and signature** with `node:crypto` (`src/push/webpush.ts`): content per RFC 8291 (`aes128gcm`, one record, at most 3,993 bytes of plaintext), VAPID per RFC 8292 with ES256, valid for 12 hours and reused per push service for one hour. The server creates the key pair on the first start and stores it in the table `settings`, so it is in every backup together with the subscriptions. If it is lost, all subscriptions are worthless; the services then answer with errors, and the subscriptions disappear by the rules below.
- **Contact (`sub`).** `PUSH_CONTACT`, otherwise the `https` origin of the page on which the subscription was created; without `https` (local development) the placeholder `mailto:gamehearth@invalid`.
- **Content.** JSON with `kind` (`turn`, `finished`, `test`), `room`, `game` and `lang`, never names or game content. `lang` is the user's language, otherwise the language of the subscription's device, otherwise `en`; it is worked out per device, also for the test message. `game` is the game's name in `lang` (if the game does not have it, in its default language, the first of `languages`), shortened to 80 characters. The service worker builds the texts in `lang`. Headers: `TTL: 43200`, `Urgency: high` for "Your turn", otherwise `normal`, `Topic` as an HMAC over subscription and room with a secret key from `settings` (with it the service replaces a not yet delivered message of the same room, but sees neither the code nor which devices play together).
- **Sending.** Queue in memory with at most 1,000 messages (the oldest are dropped, noted in the log), 8 at a time, 10 seconds timeout. 201 and other 2xx count as delivered. 404 and 410 delete the subscription. 429, 5xx, timeout and network errors get a second attempt after `Retry-After`, otherwise after 30 seconds, at most after 5 minutes; if that fails too, it is only noted in the log. Other 4xx responses count as a failure of the subscription; after 5 in a row over at least one day it is deleted, a success resets the counter. A message that cannot be encrypted is discarded. Pending messages do not survive a restart.

## Languages

The UI exists in English and German (decisions in `docs/design.md` under "Arcade UI and multilingual support"); the server knows these languages in `src/languages.ts`.

- **Language of the user.** `POST /api/me/language` stores `en`, `de` or `null` in `users.language`, for accounts and guests; `GET /api/me` and every other response with `user` carry it. `null` means the device decides (browser language).
- **Push.** Every subscription also stores the language of its device (`push_subscriptions.language`); see [Web push](#web-push) for `lang` in the payload.
- **Texts of games.** Game name, description, option and choice labels and the labels of the catalog (`items`, `stats`, `flags`) are a text or an object with one text per language in the manifest (`Localized` from the SDK). The server sends them unchanged in every API and WebSocket message, and so does it for a catalog's game names and descriptions; the UI picks the language. Where the server itself writes a game's name (log, error messages, push), it takes the game's default language; for push it takes the user's language, otherwise the language of the device, otherwise English, and falls back to the game's default language if the game lacks it. Information about a game (game list, game page, room, admin view) also carries `languages` (from the manifest, the default language first) and `cover`, the address of the cover image in the current build (`/games/<id>/<version>+<hash>/<cover>`), only if the manifest names one and the build contains it.
- **Texts of the server.** The server writes no texts for players: a deleted seat has `deleted: true` and an empty name, a device has `browser` and `system` instead of a label, and API messages are English developer texts next to a stable `code`. Only the hint page for game files opened as a page is German or English by `Accept-Language` (see [HTTP](#http)).
- **Theme of the user.** `POST /api/me/theme` stores `neon`, `crt`, `front` or `null` in `users.theme` (migration v12), like the language; every response with `user` carries `theme`.
- **Migration v11** adds `users.language`, `push_subscriptions.language` and `catalogs.error_code`, all empty at first; as before every migration, the server backs up the database first (see [Backup](#backup)).

## Backup

Before every schema migration and then once a day, the server writes a consistent copy of the database to `DATA_DIR/backups` with `VACUUM INTO` (`gamehearth-<time>-daily.sqlite`, `-manual`, `-migration-v<old version>`). It keeps the seven newest daily copies, separately the seven newest manual copies, and all copies made before migrations. A manual backup does not shift the daily one. If the copy before a migration fails, the server does not start. This protects against errors and broken migrations, not against a disk failure; the operator backs up the folder as well.

Restoring: stop the server, put `gamehearth.sqlite` together with `-wal` and `-shm` aside, copy the desired copy in its place as `gamehearth.sqlite`, start the server. A copy from before a migration is migrated again at start.

## Not included yet

- Passkeys
- Uploading packages without a catalog, untrusted catalogs, signatures
- Joining running realtime matches (joining happens in the lobby between rounds)
- Handing a seat to a bot or a new player
- Quarantine across a restart (the admin view shows quarantined builds until the restart)
- Pool of several sandbox workers (comes when realtime games need more computing time)
