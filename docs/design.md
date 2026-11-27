# Gamehearth – Design

As of 2026-11-25. Based on the grilling session of 2026-11-14; later decisions carry their own date.

## Idea

A fully open-source game platform that anyone can host themselves. Players open a client on any device, connected to the platform server of their choice. The server has only the games installed that the operator wants. There are games for one or more players, turn-based or realtime, for one or several groups of devices. All games are open source as well and are contributed by the community. Game development is built so that non-programmers, too, can create games with AI agents.

## Audience and stages

The platform is built **first for our own circle** (family, friends, a server of our own). The repo is private until the first game (a card game) runs, and then becomes public (it did in step 16, see "Publication (step 16)"). Community registry and moderation come only once the platform has proven itself. The server sandbox has been moved forward (see "Sandbox on the server").

It follows: everything that concerns outsiders may come later. But whatever would later only be possible by reworking the games is part of the contract already now (reducer purity, package format, license information, client isolation).

## Architecture overview

```
┌──────────────────────── Device ────────────────────────┐
│  PWA (served by the server)                            │
│  ┌──────────────────────────────────────────────────┐  │
│  │ Platform UI: login, catalog, rooms, admin        │  │
│  │  ┌────────────────────────────────────────────┐  │  │
│  │  │ Game in a sandbox iframe                   │  │  │
│  │  │ Client bundle + SDK  ── postMessage ──►    │  │  │
│  │  └────────────────────────────────────────────┘  │  │
│  └──────────────────────────────────────────────────┘  │
└───────────────────────────┬────────────────────────────┘
                            │ HTTPS + WebSocket
┌───────────────────────────▼────────────────────────────┐
│  Platform server (TypeScript, one Docker container)    │
│  Accounts · guests · catalogs · installation · rooms   │
│  Reducer runtime: QuickJS sandbox in a worker thread   │
│  SQLite: accounts, rooms, saves, high scores           │
│  Games directory: installed packages per version       │
└───────────────────────────┬────────────────────────────┘
                            │ HTTPS (catalog.json + packages)
                 ┌──────────▼──────────┐
                 │ Catalogs, releases  │
                 └─────────────────────┘
```

## Decisions

### Licenses

- **Server and client: AGPL-3.0.** Whoever runs a modified platform as a service must disclose the changes.
- **SDK, dev tool and templates: MIT.** Games can be licensed freely with them; a copyleft SDK would force copyleft on all games and exclude engines.
- **Catalog games:** code under an OSI license, graphics and sound under CC0, CC-BY or CC-BY-SA. Both are stated in the manifest and checked by `check`.

### Game runtime

A game is a **web bundle** (HTML5, JS, WASM) and uses the platform SDK. The engine is free to choose (Phaser, Three.js, Godot web export, plain canvas). There is a recommended starter stack that the AI templates are tailored to: Phaser 4 with Vite and TypeScript (see "UI and game client").

Reason: runs wherever a browser runs; a game doesn't have to be built per platform. A fixed engine (Godot) would be more unwieldy for AI and non-programmers; a custom fantasy console would exclude too many genres.

### Client

- **The server delivers the client as a PWA.** The server URL is the whole configuration. No app stores, updates come with the server, one icon on the home screen per server.
- Limitations on iOS (fullscreen, notifications) are accepted.
- A dedicated app with a server list (Tauri/Capacitor as a shell around the same PWA) is deferred.

### Isolation in the client

Each game runs in an **iframe with a `sandbox` attribute without `allow-same-origin`** and with a strict CSP (no `fetch`, no WebSocket, no external images or scripts; for the gap in WebRTC see "UI and game client"). The SDK in the game talks to the platform only via `postMessage`, and the platform checks every request.

Reason: if a game runs on the same origin as the platform, it can read the login token and act as the player, and for an admin that means reconfiguring the server. A separate subdomain per game would also be safe, but requires wildcard DNS and wildcard certificates from every self-hoster.

### UI and game client

Decided on 2026-11-17 in a grilling session before step 5.

**Platform UI:** Preact with Vite in the package `packages/client` (AGPL-3.0). There are few screens (home, lobby, frame around the game) with a lot of state from the WebSocket. Preact is small and well known to AI agents; Vite brings a dev server with a proxy to the server and builds the PWA. The UI is German, all texts are in one place. Rejected: Svelte (its own compiler and its own type checking), plain TypeScript (every update wired by hand), Lit (state across several components is cumbersome). Since step 12 the UI speaks German and English (see "Arcade UI and multilingual support (steps 11 and 12)").

**Client part of a game:** a fully built folder with `index.html`, in the manifest as `"client": "dist/client"`. The game builds it itself. When installing, the server copies it into the build, and the hash of the build covers manifest, reducer and client. A game without a client folder is not installed; `check` reports missing folders, a missing `index.html` and clients over 50 MB. Reason: from step 7 on, a game package contains a ready-built client bundle anyway, and engines like Godot only deliver exports. Rejected: the server builds the client from source (JavaScript games only, would have to be reworked again in step 7); a single HTML file (graphics and sound only as `data:` URLs).

**Starter stack: Phaser 4 for all kinds of games**, including card and board games, with Vite and TypeScript. One template for everything, the same engine for realtime, party games and single player. Mau-Mau is the first example. Whatever a UI decides (layout, playable cards, which tap is which move) lives in pure functions without Phaser, so it stays testable. Phaser 4 has been stable since April 2026; agents occasionally write Phaser 3 code, so the starter docs name the differences that affect us. Rejected: Preact for turn-based games (two templates instead of one), plain DOM, Phaser 3.90 (hardly maintained anymore; a later switch would hit all community games).

**Redesign planned (request from 2026-11-18):** So far the platform UI looks plain and rather disappointing. It should have a wow effect when opened and be modeled on a retro arcade hall. This concerns the platform's pages (home, lobby, game page, account, admin view, TV), not the games themselves. Before the step, a grilling session decides what exactly this looks like, for example font, colors, light and motion, sound, how the games are shown (for example as arcade machines), readability and handling on the phone, accessibility (reduced motion) and performance on older devices. Planned as step 11 after the profiles; decided on 2026-11-22 (see "Arcade UI and multilingual support (steps 11 and 12)").

**Game in the iframe:** The server serves each build under `/games/<build>/`; the platform embeds its `index.html` in `<iframe sandbox="allow-scripts">`. For every game file the server sends:

- a CSP with `sandbox allow-scripts` that also applies when someone opens the file directly in a tab (since step 7 the server rejects opening it directly anyway, see "Game packages and catalogs"),
- sources for scripts, images, sound, fonts and requests only from the build's own folder,
- `Access-Control-Allow-Origin: *`, because the opaque origin of the iframe counts as foreign and Phaser loads assets via requests,
- a long cache time, because a build never changes.

A self-hoster doesn't have to set anything up for this. Rejected: a separate games origin (a second name plus certificate for every self-hoster) and `srcdoc` with files via `postMessage` (a lot of custom code, Phaser's loader would have to be bent).

Known limitations (verified in the review on 2026-11-17, browser tests in `e2e/play.e2e.ts`):

- **WebRTC is open.** CSP doesn't govern WebRTC. With `RTCPeerConnection` a game can reach its own STUN or TURN servers and so build a channel to the outside in both directions, for example to send its own hand to another player or to accept moves from outside. Chromium doesn't know the CSP directive `webrtc 'block'`, and `RTCPeerConnection` can't reliably be taken away from a game either. It only affects what this player sees anyway. A browser test records the gap and fails as soon as a browser closes it. Decided in step 7 (see "Game packages and catalogs", "Trust"): there are only trusted catalogs, the dialog when adding one names the gap, and `webrtc 'block'` is in the games' CSP anyway, for browsers that know it.
- **Redirecting the iframe** to a foreign address is prevented in Chromium by the platform's CSP (`frame-src 'self'`); the foreign server gets no request (browser test). Firefox and Safari are not checked for this. Whoever loosens `frame-src` opens this path again: the platform sends new snapshots to the iframe with target `*`.
- Sandbox iframes don't reliably use the platform's service worker; offline games (game 3) therefore need a way of their own (decided before step 9: preloaded HTTP cache, see "Single player, saves and offline").

**Client SDK** `@gamehearth/sdk/client` (MIT), without a framework:

```ts
import { connect } from "@gamehearth/sdk/client";

const game = await connect<Snapshot, Action>();
game.onUpdate(({ snapshot, players, online }) => render(snapshot, players));
const result = await game.move({ type: "play", card: "herz-7" });
```

- The platform holds the WebSocket and the token. The game talks to it only via `postMessage`.
- `players` gives, per seat, the name, the connection status and whether it is one's own. Names never end up in the state.
- `move` returns `{ ok: true }` or `{ ok: false, code, message }`. The SDK attaches the `version` of the last shown snapshot as `expectedVersion`. The platform doesn't display a `stale`, because the new snapshot comes anyway.
- Reconnecting, incidents (`game-error`), rate limiting and quarantined builds are shown by the platform itself. Games hardly have to handle any errors.
- On every message from the iframe, the platform checks the sender (`event.source`), shape and size.
- The iframe is only created once the match is running or over. The lobby belongs to the platform.

Rejected: an SDK made only of events without return values (every game builds its own error display, and AI code easily forgets it).

**PWA:** manifest and a small custom service worker. It caches only the platform shell (hashed files), always fetches `index.html` from the network first and never touches the API, the WebSocket or games. Offline, the app starts and reports "No connection to the server" ("Keine Verbindung zum Server") instead of a browser error page. Rejected: no service worker at all, and full offline capability already now (does nothing for Mau-Mau).

**Identity on the device until step 6:** `localStorage` held the list "Your rooms" ("Deine Räume") (code, token, name, game) and the last used name. Since step 6 a session in a cookie replaces the tokens, and "My rooms" ("Meine Räume") comes from the server (see "Accounts and guests"). The platform itself has a strict CSP (own scripts only), so that no injected code can grab anything.

**Joining:** code, link `/r/<code>` (the device's share menu or copying) and a QR code in the lobby. Since step 6, after opening the link you join with your account or as a guest.

**New round and abort:** After the end, the host starts a new round in the same room. The room goes back to the lobby with the same members and tokens, the new match uses the current game build, and the history counts rounds. The host can abort a running match after a confirmation prompt; that takes the same path, just without a result. That way a round doesn't hinge on someone who doesn't come back. Any member can leave a finished room. Rejected: rematch as a new room (new tokens for everyone, "Your rooms" fills up).

**"Your turn" ("Du bist dran"):** only in the app, via the title and the app badge, a short vibration and a screen that stays on during the match (Wake Lock). That reveals nothing, because for this the platform only looks at one's own moves. Web push came after the accounts (step 6b), because a subscription belongs to a person and not to a room token (see "Web push").

**Visual design:** plain but careful (replaced by the neon hall in step 11, see "Arcade UI and multilingual support (steps 11 and 12)"). The platform has its own CSS variables, light and dark, is built for phones first and uses the system font. Mau-Mau has self-drawn cards (CC0), a felt table, other players with name, card count and a "to move" marker ("dran"), highlighted playable cards and short animations, no sound.

**Tests:** `npm test` (Vitest, components with happy-dom) stays fast. `npm run e2e` (Playwright with Chromium, not part of `npm test`) plays a whole match with two browsers and checks that the iframe reaches neither `localStorage` nor `/api`. Sandbox, CSP and `postMessage` only behave for real in a real browser.

**Rollout:** Docker image (`node:22-slim`, multi-stage) from this repo. A self-hoster may keep the server reachable only at home or over a VPN; that mattered because there were no accounts until step 6.

**Not in step 5:** the `dev` command (comes with the starter repo in step 7b), web push, offline games, bots for empty seats, picture cards and sound.

### Roles and devices

- From the start the SDK knows **roles per device**: `player`, `screen`, `controller`. With that, "everyone on their own device" and "the TV shows the field, phones are controllers" work with the same SDK, and TVs don't need a client of their own.
- The **manifest declares per role** the required inputs (`touch`, `keyboard`, `mouse`, `gamepad`) and a minimum screen class (`small`, `medium`, `large`). The client uses this to filter the catalog ("playable on this device") and offers matching roles. Refined before step 8: the client marks games instead of hiding them, and the TV joins the room by pairing (see "Realtime, roles and TV").

### Game logic in multiplayer

**The server is the authority.** Every multiplayer game ships a reducer that runs on the server:

```
(state, action) → newState
```

Reason: cheat-proof, no host device the game depends on, and turn-based matches can run for days.

**Reducer contract (binding from now on):**

- pure, deterministic function
- no I/O, no network, no file system
- no `Date`, no `Math.random`: randomness and time come only via the SDK (`ctx.random` with a seed from the server, `ctx.now`)
- state is serializable JSON

`check` enforces these rules. Thanks to that, the runtime could move into a sandbox without any game having to be changed.

### Sandbox on the server

Decided on 2026-11-16 after a feasibility probe and **inserted before step 5**: a review had shown that an infinite loop in the game code blocks the whole server. Instead of an interim solution, the sandbox comes right away.

- **Game code runs in QuickJS** (bellard/quickjs via `quickjs-emscripten`, WebAssembly, no native dependency). The server process itself no longer runs any game code, not even when installing. SDK runner and game run together in the sandbox; the host passes in only JSON (match, move, time) and gets JSON back. A Mau-Mau move costs about 0.6 ms, roughly four times as much as in V8.
- **One sandbox per room**, each with its own WASM module and hard-capped memory (16 MB base load plus 32 MB). It is reused for all moves of the room and set up anew after a timeout, after more than 8 MB of memory growth, after a crash and after a longer pause; at most 64 live at the same time. Reason: QuickJS's own memory limit doesn't work under Emscripten, and after an overflow of the native stack a module can no longer be used; a separate module per room limits both to that room.
- **All sandboxes run in one sandbox worker** (worker thread with a 4 MB stack). The QuickJS time limit (100 ms per call) is only cooperative; expensive built-in functions such as `sort()` on large arrays bypass it. So the main thread monitors the worker via a heartbeat and terminates it after a hard limit (500 ms per call, 3 s when loading). Then it restarts it, reports an error to the guilty room and retries the other pending calls once. A game build that was aborted three times hard or ten times soft (time limit, memory, invalid output) within 10 minutes is quarantined until the restart. The main thread stays free for connections and requests meanwhile; game code of other rooms waits in the same worker until the abort has happened.
- **The host doesn't trust the sandbox.** Game code in the guest can bypass every check of the SDK. So the host checks the size (at most 256 KB in UTF-8 and 20,000 nodes), the depth and every field it relies on, and keeps only those fields.
- **Prelude in the guest:** `Math.random`, the clock (`Date()`, `Date.now`, `new Date()` without an argument), everything that depends on the time zone (date methods with local time, `Date.parse`, `new Date` with a string or several arguments), `eval` and all function constructors are blocked before the game loads; `check` blocks the same in Node. So the reducer contract holds on the server as well.
- **The JS engine is part of the game build.** QuickJS computes `sin`, `exp`, `pow` and relatives partly 1 to 2 digits differently from V8, `localeCompare` knows no locale, and `console`, `structuredClone` or `Intl` are missing. So `check` additionally replays matches in QuickJS and reports games that run differently there or fail.
- **isolated-vm stays in reserve**, in case realtime games need more compute than QuickJS delivers. Against it today: native dependency, maintenance mode, `--no-node-snapshot` from Node 20 on, and a memory limit that is only a guideline.
- Rejected: one container per game (too much RAM and storage on a small server, contradicts the goal of keeping the server lean); a pool of V8 workers as an interim solution (would have caught infinite loops, but neither limited memory nor prevented access to Node).

### Realtime

The reducer additionally gets `tick(state, dt, ctx)` with a fixed tick rate (guideline 20 Hz). Clients send inputs and smooth the display between two states (interpolation).

That is enough for party, arcade and co-op games, especially in the home network. Fast shooters or precision platformers feel sluggish over the internet. That is accepted. Client-side prediction with rollback is deliberately deferred: it would be possible because reducers are deterministic, but it is the hardest network code and makes debugging much harder for AI developers.

How inputs, ticks, pauses and saving work in detail is described under "Realtime, roles and TV" (decided before step 8).

### Single player

A **reducer is optional for single player.** Single-player games may be built in any way, even with engine physics and their own game loop, and use only save, high score and input from the SDK. Whoever wants multiplayer writes a reducer.

Consequences: two kinds of templates instead of one; high scores from single-player games can be faked by the client (doesn't matter in our own circle). Single-player games should be playable offline. How saves, best scores and offline play work was decided before step 9 (see "Single player, saves and offline").

### Hidden information

The state of a multiplayer game has a **fixed structure**:

```ts
type GameState<Public, PerPlayer, Secret> = {
  public: Public;
  players: Record<PlayerId, PerPlayer>;
  secret: Secret;
};
```

- `public` is seen by everyone
- `players[id]` is seen only by that player
- `secret` is seen by no one, only by the server (e.g. the order of the deck)

The platform filters automatically before a state reaches a device. Reason: a freely written `playerView` function can silently forget something, and AI-built games in particular make this mistake without anyone noticing. Special cases (teams, "only neighbors see it") are less elegant this way; an optional `playerView` on top can come later, if a real game needs it.

### Rooms and persistence

- Room states are stored in **SQLite**: for turn-based games after every action, for realtime only as a snapshot or not at all (decided before step 8: a snapshot every 10 seconds, see "Realtime, roles and TV").
- A room stays **on the game version it was started with** until the end. Updates only apply to new rooms and to a new round in the same room.
- Old game versions stay installed as long as rooms still run on them, and are cleaned up afterwards.
- Migration of running rooms (`migrate(oldState)`) is deferred.

### Player count and lobby

Each game declares in the manifest how many players it is suited for:

| Meaning | Manifest |
|---|---|
| 2–5 players | `"players": { "min": 2, "max": 5 }` |
| exactly 4 players | `"players": { "min": 4, "max": 4 }` |
| 3 players or more | `"players": { "min": 3 }` |
| only 4 or 6 (teams) | `"players": { "min": 4, "max": 6, "counts": [4, 6] }` |

- Only seats with the role `player` or `controller` count, not `screen`.
- Without `max`, an upper limit applies that the server operator sets (guideline 12).
- `counts` is optional and only meant for special cases that can't be expressed as a range.

**The platform enforces this, not the game:**

- Every multiplayer room starts in a **lobby**. Starting only works once the player count fits; once the room is full, nobody else can join.
- `setup` gets the players via `ctx.players` and may rely on the count being valid. Games don't check this themselves, one source of errors fewer for AI-built games.
- The catalog shows the player count and can filter by it ("what can we play with five?").
- `check` plays the bot matches for **every allowed player count**, with an open `max` up to a test limit. The edges in particular (minimum, maximum) break easily in AI code.

**When someone leaves mid-game:**

- The seat stays reserved, the player can come back. For turn-based matches over days this is the normal case.
- In realtime the room pauses as long as a seat is empty.
- Whoever created the room can give an empty seat to a bot (via `legalMoves`) or to a new player.
- You only get into a running match through such a freed-up seat.

Refined before step 15 (see "Bots, playing on and sound (steps 15 and 15b)"): bots come from an optional game function `bot`, the host fills up the lobby with them and hands seats without a device to them, everyone can hand over their own seat, and only that person takes it back; a seat is never given to a new player. Realtime games may declare that they play on without seats that are away.

### Game data, options and profiles

Result of a separate grilling session on 2026-11-15. Contract fixed, **built after the MVP** (after step 7). Mau-Mau needs none of it.

Refined on 2026-11-18 before step 10 and changed in four points in the process (see "Options and profiles from step 10"): the catalog of IDs is in the manifest instead of the code, a reducer writes best scores with `record` instead of `max` and `min`, `ctx.options` exists in all phases and in the client, and free single-player games don't get items, counters and flags yet. Since then Mau-Mau has house rules as options and a stat for wins (`siege`).

**Fixed game data** such as loot tables, item values, enemies and levels live **only in the game package**, as JSON or TypeScript next to the code, and belong to the game version. So a room never rolls against changed tables, matches stay replayable, and `check` checks exactly the data that is also played. The state holds **only IDs** (`"schwert-07"`), no copies of the data. For this the SDK gets `random.weighted(table)` for weighted drawing.

Rejected: values that the server admin can override per server. `check` would only check the default values, and profiles would no longer be comparable between servers. Variants go through game options instead.

**Game options.** A game declares options in the manifest with type, choices and default, for example `loot: wenig | normal | viel` (little, normal, lots) or house rules like "stacking 7s: yes/no". Whoever creates the room chooses them in the lobby; they go into `setup` as `ctx.options` and are saved with the match. `check` plays through every option at least once. (Since the decision before step 10, `ctx.options` is available in all phases, and the client gets the options with every snapshot.)

**Profiles.** Every account has one profile per game, managed by the platform. Games don't get a database of their own: foreign community code with database access would be a security problem, every self-hoster would need migrations and backups, and replayability would be gone. A shared, persistent world across all players (auction house, shared map) deliberately does not exist.

A profile has three fixed areas:

| Area | Content | Example |
|---|---|---|
| `items` | ID → count | `{ "trank-heilung": 3, "schwert-07": 1 }` |
| `stats` | name → number | `{ "xp": 1250, "siege": 14, "bestzeit": 83 }` |
| `flags` | name → text or `true` | `{ "held-magier": true, "kapitel": "3" }` |

Games change profiles **only through operations**, never by replacing them: item ±n, stat ±n, keep the higher or lower of the stored and the new value of a stat (`max`/`min`, for high scores and best times), set or delete a flag. The platform applies them atomically to the current profile. So no match loses the finds of another, even if the same player sits in two rooms in parallel.

**The server decides per move.** On every call the game sees the current profile, not the one from the start of the match. Move and profile changes are accepted together or rejected together: if an item that the move consumes is missing by now (because another match consumed it), the server rejects the whole move with an error code of its own, and the state stays unchanged. This makes currency, shops and consumption possible without double use. For replayability the server stores the profile it read with every move. If a profile changes through another match, the server recomputes the legal moves and notes that in the history.

Rejected: writing only at the end of a match (progress is lost on abort) and "gains only" (no consumption, no currency).

**Interface:**

- `ctx.profiles[seat]` reads the current profile of each seat, in `setup`, `apply` and `legalMoves`. For this, `legalMoves` gets `ctx` as an optional third parameter, so that it can, for example, offer "drink potion" only when there is one. Existing games don't break because of this.
- In `apply` the game writes via `ctx.profile.add(seat, id, n)`, `.use(seat, id, n)`, `.stat(seat, name, n)`, `.max(seat, name, value)`, `.min(seat, name, value)` and `.flag(seat, name, value)`. That fits the style "mutate the state directly". (Decided before step 10: `.record(seat, name, value)` replaces the operations `.max` and `.min`; writing happens in `apply` and `tick`.)
- The profiles of all seats are readable for the game logic (for example for collectible card decks); what other players see of them is, as always, decided by the state.

**Guests** get an empty throwaway profile. The game works with it completely normally and doesn't have to know about guests; changes apply within the match and are discarded at the end.

**IDs are forever.** Profiles outlive game versions, rooms don't. So an item, stat or flag ID, once published, may never disappear or change its meaning, only be marked as deprecated. Next to `defineGame` the game exports a **catalog** of all IDs, usually directly from its data tables (changed before step 10: the catalog is in the manifest, and the data tables take their ID types from there). The server rejects operations with unknown IDs, which catches typos. `check` keeps an `ids.lock` in the game repo and reports when an ID listed there is missing, including rare drops that bots never earn.

Rejected: profile migrations by the game (old rooms would then read an already migrated profile; migration code is a typical source of AI errors) and silently ignoring unknown IDs.

**Free single-player games** without a reducer may send the same operations via the client SDK (deferred before step 10; they stay with save and `record`). The server checks catalog and inventory, but marks them as "from the client", because they can be faked. That way saves, unlocks and high scores work the same everywhere. A first piece of this already comes with step 9: best scores as stats with `max` or `min`, plus a save document that doesn't exist in the profiles (see "Single player, saves and offline").

**Leaderboards** are built from stats. The game marks in the catalog which stats are ranked and whether higher or lower is better. The platform shows them without further game code, with values from the client kept separate.

**Limits:** at most 1,000 different items, 200 each of stats and flags, flag texts up to 200 characters, per profile. Admins can reset or delete an account's profile.

**Checking by `check`:** bots play with empty profiles, with profiles filled randomly from the catalog, and with guest profiles. Between moves `check` occasionally takes items away to simulate parallel matches. It also reports operations with IDs outside the catalog and IDs missing compared to `ids.lock`.

### Accounts and guests

- **Local accounts** on the server; the admin invites via invite link.
- **Guests** join a running room via QR code or link, without an account and without saved progress. This matters above all for party games with the phone as controller.
- OIDC (Authentik, Keycloak, Authelia) as an additional login method is deferred.

Decided on 2026-11-17 in a grilling session before step 6:

**Internet-proof, but not open.** Step 6 is built as if Gamehearth were openly on the internet: brute-force protection, CSRF protection, secure cookies, rate limits. Reason: security is hard to retrofit, and other people may host the platform openly. Whether a particular server is opened up to the internet is up to its operator.

**A guest is a user without a login.** Accounts and guests are in one table `users`; room members point to `user_id`, and the room tokens from step 5 are dropped. Profiles (after the MVP) hang on `user_id`, and guests still get a throwaway profile. Rejected: guests keep a token per room (every code path would then know two kinds of members, and a guest wouldn't take their seats along).

**Session via cookie.** Each device has at most one session: a random ID in the cookie (`HttpOnly`, `SameSite=Lax`, `Secure` over HTTPS), stored in the database only as a hash. Account sessions are valid for a sliding 90 days, guest sessions as long as the guest exists. Against CSRF the server checks the `Origin` on every `POST` and when the WebSocket is set up. `hello` now only names the room; the person comes from the cookie. Under "My devices" ("Meine Geräte") you log out single sessions or all of them; open WebSockets of an ended session are disconnected. Rejected: a token in `localStorage` (any injected script could read it).

**Login with username and password.** The username is unique regardless of upper and lower case, 3–32 characters (letters, digits, `.`, `_`, `-`) and can only be changed by the admin. The display name is free (1–24 characters), not unique, can be changed at any time and applies in all rooms, also retroactively. Passwords: at least 10 characters, no other rules, stored with scrypt from `node:crypto` together with the parameters. The credentials live in a table of their own with a type, so that passkeys can be added later without rework. Rejected for now: passkeys (their own library, a path for new devices without a synced passkey) and a single name for both login and display.

**Brute-force protection without lockout.** Per address 10 failed attempts in 15 minutes, then `rate-limited`. Per account, from 5 failed attempts on, a growing wait of up to 15 minutes during which even the correct password is rejected; there is no hard lock, so that nobody can deliberately lock someone out of an account. Unknown usernames cost the same computing time. A successful login resets the counter.

Tightened after the review (2026-11-17): the per-account wait applies per address, otherwise a single attacker could have locked the owner out permanently with one failed attempt every 15 minutes. Across all addresses, only distributed guessing is slowed down (50 failed attempts per hour); only such an attack can still lock an account out temporarily. Attempts count before the password is checked, so that concurrent requests can't get around the limits, and at most two password hashes run at the same time. Changing the password is slowed down just like the login. Behind the proxy, the server takes addresses from the last entry of `X-Forwarded-For`, and it groups IPv6 addresses per /64. Exempting a device that has logged in before from the wait (device cookie) remains open as a possible extension.

**First admin.** As long as there is no admin, the server writes a one-time setup link `/setup/<token>` to the log at startup; whoever opens it creates the admin. For emergencies, a command in the container prints a new admin link or a reset link for an account. Rejected: admin from environment variables (password in plain text on disk) and "first visitor becomes admin" (not justifiable for an open server).

**Invites** are created only by admins. Each link creates exactly one account, is valid for 7 days, carries the role (player or admin), optionally a note ("for Grandma", only visible in the admin view) and suggested names. Open links are listed in the admin view and can be revoked; only the hash is stored. Rejected: multi-use links (a forwarded link creates accounts for strangers).

**Forgotten password** without a mail server: an admin creates a reset link (one-time, 24 hours) and passes it on themselves. The new password ends all sessions of the account. The last admin can't demote, lock or delete themselves.

**Guests may only join**, via link, QR code or code, and play fully there. Creating rooms and inviting work only with an account. A guest starts on one device (since 2026-11-17 they can also get onto further devices with a transfer code, see "Continuing on another device"), can sit in several rooms and expires after 30 days without activity. If a guest opens an invite link on the same device, the guest becomes an account; name, rooms and seats stay. If an existing account logs in on a device that has a guest, the app asks whether the guest's seats should be taken over. Yes: the seats move to the account (except in rooms where the account already sits), and the guest is deleted. No: the guest stays, but can no longer be reached on this device and expires. If the guest is still logged in on another device (possible since the transfer code), the app doesn't ask, and the guest stays. Rejected: taking over automatically (on shared devices the child's seat ends up in the mother's account).

**All memberships are tied to the user.** "My rooms" comes from the server, every logged-in device gets into all of one's own rooms, and a user sits at most once per room. `localStorage` no longer holds anything secret.

**Locking and deleting.** Locking ends all sessions and prevents login; the seats stay, and unlocking restores everything. In lobbies and finished rooms, deleting acts like leaving (with a change of host); in running matches the seat stays as "Deleted" ("Gelöscht") and also remains visible in the result, until the next round or until the match is aborted. The same applies to expired guests. Open invites and reset links of a locked, deleted or demoted admin expire with them.

**Admin view:** users (change role, lock, delete, reset link), invites (create, revoke), quarantined game builds with the reason, all rooms with "Close room" ("Raum schließen") and backups with "Back up now" ("Jetzt sichern").

**Migration from step 5.** Existing rooms stay. Every old member becomes a guest with their name. The new UI sends the room tokens stored on the device to the server once; the server attaches the matching seats to the device's session (guest or account) and deletes the token hash. After that the UI throws the tokens away. Whatever nobody redeems expires under the 30-day rule.

**Limits** (all configurable via environment variable): at most 20 open rooms as host per account (admins without limit), at most 50 rooms per user. Finished rooms without activity disappear after 30 days, running matches without a move after 90 days; "My rooms" announces this beforehand. Guests expire after 30 days without activity.

**Database backup.** Before every schema migration and then daily, the server writes a copy to `DATA_DIR/backups` with `VACUUM INTO` and keeps the last 7 daily ones, separately the last 7 triggered by hand, and all copies made before migrations. This protects against errors and broken migrations, not against a failing disk; for that the operator backs up the folder as well (for example with restic).

**Not in step 6:** web push (its own step 6b right after; subscriptions hang on `user_id`), passkeys, OIDC, self-registration, deleting one's own account, sending mail and opening up a server to the internet.

**Settled while building** (details in [packages/server/README.md](../packages/server/README.md)):

- Links carry their token in the fragment (`/setup#…`, `/invite#…`, `/reset#…`) instead of the path. That way it appears in no request and no proxy log; the UI sends it in the body.
- The emergency command in the container is called `admin.js`, with `admin-link` (invite for a new admin, 24 hours) and `reset-link <username>`.
- Scrypt runs with `N=2^16, r=8, p=2` (one of the settings named by OWASP, about 250 ms on a small server, 64 MB per hash).
- The server cleans up lobbies after a new round like finished rooms, after 30 days; lobbies that were never played still after 24 hours.
- Redeeming old tokens and taking over guest seats ignore the limit of 50 rooms, so that no seat gets lost in the process.
- An admin may delete other admins and themselves, as long as another admin who isn't locked remains.
- Members whose user has disappeared are removed right away in lobbies and finished rooms and never become host; only in running matches do they stay as "Deleted".
- Browser tests against a foreign server create their admins via `GAMEHEARTH_ADMIN_LINK_COMMAND` and delete their accounts and rooms afterwards; all that is left are test guests without a room, which expire after 30 days.

### Web push

Decided on 2026-11-17 in a grilling session before step 6b.

**Triggers.** The server pushes "Your turn" and "Match is over" ("Partie ist vorbei"), nothing else. "Your turn" goes to a seat when it changes from having no legal moves to having legal moves, also at the start, if it has the first move. So whoever has several moves in a row gets one push, not several. For this the platform, as in the app, looks only at the moves of this seat and doesn't reveal to anyone else who currently has moves. "Match is over" goes once to all members with a seat. Lobby, joins, new rounds and aborts don't trigger a push. Rejected: lobby events (more notifications, requires settings per event type).

**Whoever is watching gets nothing.** The app reports via the WebSocket whether it is visible (`visibilitychange`). If a connection of this member in the room is visible, no matter on which device, no push goes out, not to other devices either. An open connection alone isn't enough: a tab in the background stays connected, and on iOS the connection lives on for up to a minute after swiping the app away. When a push arrives, the service worker always shows it; Safari revokes subscriptions after silent pushes, and Chrome otherwise shows a fallback notice of its own. Rejected: the service worker decides (risks the subscription on iOS, other devices ring anyway) and "every connection counts" (a forgotten tab on the PC prevents all pushes to the phone).

**Content.** Title "Your turn" or "Match is over", body text game name and room code, e.g. "Mau-Mau · Room ABC234" ("Mau-Mau · Raum ABC234"), never names or game content. The content is end-to-end encrypted; the push services of Google, Apple, Mozilla and Microsoft see only time, size and recipient. The text does show on the lock screen, though. There is at most one notification per room (`tag` is the room code); the newest replaces the older one. A tap opens `/r/<code>`, in an already open window of the app if there is one. When you open the room, the app clears its notification. Rejected: names of the other players (reveals on the lock screen who plays with whom) and completely neutral notifications (you don't know which room).

**The subscription hangs on the session.** Every subscription is stored with `session_id` (`ON DELETE CASCADE`) in a table of its own; the user follows from that. Logging out, "Log out device" ("Gerät abmelden"), locking, deleting, resetting the password and the expiry of a session remove the subscription too, without any extra code. After a login on a device you turn push back on there with one tap; the browser's permission remains. Guests get push like accounts, because they, too, sit in matches that last for days. Rejected: one subscription per device independent of the session (on shared devices the wrong person would get the notification, and logging out would need extra code).

**Settings.** Push is turned on per device, because the browser asks for permission per device: under "Account" ("Konto"), where there is also a test notification to this device (at most one per minute). "My devices" shows which sessions have push. Per room, push can be muted in the room menu; that hangs on the membership and applies on all devices. There are no quiet hours; "Do Not Disturb" on the device takes care of that. Rejected: quiet hours (time zone per device, drop or deliver later) and only one switch per device (a noisy room could only be muted by leaving it).

**When the app asks.** If someone has a running match and push is off on this device, "My rooms" and the lobby show a card with "Turn on" ("Einschalten") and "Not now" ("Nicht jetzt"); the device remembers when it is dismissed. The browser only asks after the tap. On the iPhone, web push works only from iOS 16.4 on and only in the PWA added to the home screen; so in the Safari tab the card explains "Share → Add to Home Screen" ("Teilen → Zum Home-Bildschirm"). Rejected: only a switch under "Account" (nobody finds it) and asking right away at the first room (browsers suppress permission prompts the user did not trigger, and "Block" can hardly be undone).

**Own implementation with `node:crypto`.** The server itself implements the encryption per RFC 8291 (`aes128gcm`) and the VAPID JWT per RFC 8292; Node ships ECDH on P-256, HKDF, AES-128-GCM and ECDSA. It is tested against the test vector from RFC 8291 and against a fake push service that decrypts by itself and checks the signature. Rejected: the library `web-push` (five dependencies, rare releases, and we would still have to build time limits and cleanup ourselves).

**VAPID keys in the database.** The server generates the key pair in the database on first start. Every subscription is bound to the public key; that way both stay together when a backup is restored. The contact (`sub`) is `PUSH_CONTACT` (`mailto:` or `https:`), otherwise the origin under which the subscription was created (such as `https://games.example.org`). So no setup is needed, and no private mail address ends up at the push services. Rejected: a key file next to the database (easily lost when restoring, and then all subscriptions are dead) and mandatory environment variables (one more step for every self-hoster).

**Only known push services.** The address of a subscription comes from the browser and so ultimately from the user; unchecked, an account could make the server send requests into the home network. So the server accepts only `https` and only hosts of the big services: `fcm.googleapis.com` (Chrome, Android), `*.push.services.mozilla.com` (Firefox), `*.push.apple.com` (Safari, iOS) and `*.notify.windows.com` (Edge). The operator adds further ones in `PUSH_HOSTS`. The server doesn't follow redirects. Rejected: any public address with our own name resolution and protection against DNS rebinding (more code, a source of errors of its own).

**Limits and errors.** Sending runs after the move and never holds it up.

- at most 10 subscriptions per user; a new one pushes out the oldest
- 10 seconds time limit per request, 8 at the same time, a queue of at most 1,000 (the oldest drop out)
- TTL 12 hours and one `Topic` per room, so that the service collapses notifications for devices without network
- per user and room at most one push every 30 seconds; whatever comes up in between goes out afterwards as one notification with the latest state
- 404 or 410 delete the subscription; 429 and 5xx get a second attempt after `Retry-After`, at most 5 minutes later; other errors end up in the log, and after 5 failures in a row spanning at least one day the subscription is deleted

Rejected: no second attempt at all (a short outage silently swallows notifications) and a persistent queue in SQLite (too much for "Your turn").

**On the go.** The notification arrives everywhere, but a tap only opens the server where it is reachable; a server at home may be reachable only in the home network and over a VPN. The PWA then starts from the cache and reports "No connection to the server" with a general sentence about home network and VPN. Rejected: a custom text from the operator (the UI would have to know it before the outage).

**Settled while building** (details in [packages/server/README.md](../packages/server/README.md#web-push) and [packages/client/README.md](../packages/client/README.md#notifications)):

- At the start and after every move, the room compares the legal moves before and after. Muted members drop out already at this point; before a delayed send, the server checks everything once more (still their turn, not muted, nobody watching).
- A connection that says nothing about visibility counts as visible. That way an old UI that is still cached doesn't trigger pushes while someone is playing.
- `Topic` is an HMAC with a secret key of the server over subscription and room. So the push service can replace notifications of the same room for a device, but sees neither the code nor which devices sit in the same room. Only "Your turn" gets `Urgency: high`.
- Without `PUSH_CONTACT` and without an `https` origin (local development), `sub` contains `mailto:gamehearth@invalid`.
- A tap brings an open window of the app to the front and sends it into the room via a message, instead of reloading it. For "Your turn" the service worker sets the app badge. If the browser renews a subscription, the service worker reports it together with the old one; the server only replaces a subscription that this session still has.
- A guest's invite link turns their session into a new account session; after that, push is turned back on like after any login.

Tightened after the review (2026-11-17):

- Before every send, including before the second attempt, the server checks again whether the notification is still due and whether something newer has already gone out for this user and room. Otherwise a retried "Your turn" could replace a newer "Match is over" on the device.
- Only 4xx responses (except 404, 410 and 429) count as a failure of a subscription. Network errors, timeouts and 5xx only go to the log; otherwise a day without internet on a server at home would have deleted all subscriptions.
- Game names are cut to 80 characters. A notification that can't be encrypted is dropped without deleting the subscription.
- Muting is rate-limited like turning push on and off (20 per minute and address) and sends a new snapshot only to one's own connections.
- The VAPID JWT is valid for one hour per push service, as Apple requires.
- On the first load, the UI registers an enabled subscription anew once, in case a renewal by the browser didn't reach the server.

Known limitations:

- The installed app on the iPhone is logged in separately from Safari. Since 2026-11-17 you take the session along with a transfer code (see "Continuing on another device"); the notice offers the code directly.
- A window with the room that stays open in the foreground reports "visible" even if nobody is sitting in front of it; depending on the browser, also with a covered window or a switched-off screen. As long as that lasts, this user gets no push for the room on any device.
- If the app goes into the background without its report reaching the server (for example when iOS freezes it right away), it counts as visible until the next heartbeat, at most about a minute. A move in that time gets no push; the app's title and badge show it the next time it is opened.
- Pending pushes are kept only in memory; a restart of the server drops them.
- Chromium in headless mode knows no notifications and crashes when the service worker sets the app badge. So the browser tests replace permission, subscription, display and badge; sending, encryption and the service worker's handlers run for real.

### Continuing on another device

Decided on 2026-11-17 in a grilling session after step 6b. Trigger: the installed app on the iPhone is logged in separately from Safari; a guest could not get to their seats there.

**A short code to type in.** Whoever is logged in creates a transfer code and types or pastes it on the home page of the other device or of the installed app. The app has no address bar, and a link from Safari opens Safari again. The code works the same in every browser and can be tested. Rejected: a personal start URL in the manifest with a one-time token (depends on how iOS reads the manifest when the app is added, and expires if you open the app only days later) and both together (double the effort for building and testing).

**For guests and accounts.** The server cannot check whether the code is redeemed on the same device. Guests may therefore have several devices. Accounts skip the password in the iPhone app. Rejected: guests only (the second way, for accounts, would be the same amount of code and helps Grandma, for example) and guests only, and only into the app (cannot be enforced).

**Both sessions stay.** The session that created the code keeps running; the new device appears under "My devices", which for this reason now also exists for guests. A guest can log out only other devices there, not their own and not all of them, because without a password they could not get back in. If the device already has a guest with seats when the code is redeemed, the app asks, as at login, whether to take over the seats, now also when the target is a guest. Yes: the seats move (except in rooms where the target already sits; this drops a duplicate seat in a lobby), and the second guest is deleted. Rejected: moving instead of copying (Safari would be logged out afterwards) and replacing without asking (a duplicate seat in the lobby would remain).

**The code.** 8 characters from the alphabet of room codes (without 0/O and 1/I), shown as `ABCD-EFGH`; input accepts lowercase and uppercase letters, with and without the hyphen. It is valid for 10 minutes and for one use, a new one replaces the old one, and only the hash is stored. It is tied to the session that created it: logging out, locking, resetting the password and deleting make it invalid. Wrong entries count like invalid links (30 per minute and address); with about 10^12 possibilities and 10 minutes, guessing is hopeless. Rejected: 6 digits (distributed guessing conceivable with an open server) and 12 characters (tedious to type).

**UI.** Codes are created under "Account" ("Konto") in the card "Continue on another device" ("Auf einem anderen Gerät weiterspielen") and directly in the iPhone notice, each with the code, the expiry time and "Copy" ("Kopieren"). They are redeemed on the home page without login: in the installed app at the very top, in the browser below the login. The notice tells guests "Take your code with you" ("Nimm deinen Code mit"). In the new session push is off; the app offers it as usual. Rejected: redeeming also in the join form of a room link (you only get into the iPhone app via the home page anyway).

Tightened after the review (2026-11-17):

- A guest can log out only devices that were added after their own. Otherwise someone who reads a code at the table and redeems it first would have locked out the original device for good; this way, conversely, the original device can log out the intruder.
- Admins get no code; they log in with their password on a new device and in the app. An intercepted code would otherwise be an admin without a password, who could create their own admin via an invite. This deliberately narrows the decision "for guests and accounts".
- If the guest whose seats are to be taken over is still logged in on another device, there is no prompt, and the guest is not deleted.
- The prompt lists separately which seats move and where a duplicate seat is dropped; in a running match the second seat stays as "Deleted" ("Gelöscht"), and the prompt says so.
- Codes are hashed with a key that exists only in memory. A database backup thus reveals no valid code; a restart invalidates open codes.
- If a guest accepts an invite, their session ends on all other devices; there they log in with the new password. This way an intercepted code does not stay in the new account.
- In the installed app the card for redeeming is at the very top only when nobody is logged in; for a logged-in guest it is at the bottom.
- A displayed code shows "expired" ("abgelaufen") once it runs out; without a clipboard, "Copy" asks the user to type the code by hand. Under "Account" there is only one place that creates codes.

### Server stack

**TypeScript on Node or Bun**, shipped as one Docker image. Server, SDK, client and games are in the same language, types are shared, and reducers run without being translated into another language. The game developers' AI agents can also read the platform code.

Rejected: Kotlin/Java with GraalJS (familiar, but more RAM and types maintained twice) and Go with an embedded JS engine (lean, but slower for realtime ticks and a second language).

**Tools:**

- **Node** (current LTS) instead of Bun, because the later server sandbox can rely on isolated-vm, and that only runs under Node.
- **npm workspaces** for the monorepo. No extra package manager needed; anyone who has Node can start right away.
- **Vitest** for tests, **TypeScript** in strict mode.
- **`node:sqlite`** instead of a native SQLite library: no compiling, synchronous, with transactions. The module is still marked experimental in Node 22; if the interface changes, only `packages/server/src/db.ts` is affected.
- **`ws`** for WebSockets, **`node:http`** without a framework for the few HTTP endpoints.

### Game packages and catalogs

A **game package** is a ZIP with the manifest, the client bundle and optionally the reducer.

A **catalog** is a Git repo with an index (as with F-Droid): per game the name, version, roles and devices, size, download URL and checksum. A server can subscribe to several catalogs; the admin installs and updates games with a click. Only installed games take up storage. Our own catalog is the first one; the later community registry is not a new concept but just another catalog.

Decided on 2026-11-17 in a grilling session before step 7. This replaces the earlier rule "from untrusted catalogs only games without a reducer" (see "Trust").

**The package comes fully built.** A game package is a ZIP created in the game repo (command `pack`, in CI on every release). The server unpacks and checks it but no longer builds anything:

| File | Content |
|---|---|
| `manifest.json` | the game's manifest, unchanged |
| `game.mjs` | the reducer, fully bundled as an ES module, SDK included; missing for games without a reducer (since step 9) |
| `client/` | the built client folder with `index.html` |
| `LICENSE` | required |
| `README.md` | optional |
| `pack.json` | SDK and dev tool version at packing time and the result of `check` (number of warnings); for display only, not in the hash |

The layout matches the build folder on the server. The build is still named `id@version+hash12`, and the hash covers manifest, code and client as before. Engines and npm dependencies in the reducer simply work, because the server no longer bundles anything itself; in return, what runs in the package is not automatically the source code in the repo whose link the catalog shows. Limits: package and unpacked content at most 60 MB each, the client as before at most 50 MB and 5,000 files, `game.mjs` at most 5 MB. Games without a reducer (`server: false`) stay non-installable until the single-player game (game 3); since the decision before step 9, `game.mjs` is missing for them, and the hash covers manifest and client (see "Single player, saves and offline"). Rejected: sources in the package that the server bundles itself (the client would be fully built anyway, and reducers with npm dependencies would have to bring `node_modules` along).

**Our own strict ZIP.** Reading and writing is done by a small module of our own in the dev tool, based on `node:zlib`, which `pack` and the server share. The reader accepts only what `pack` writes: deflate or uncompressed, no encryption, no ZIP64, no links, unique and valid names; it checks the sizes against the limits before unpacking, and the CRC afterwards. `pack` writes deterministically (sorted entries, fixed timestamps), so that the same content yields the same checksum. Rejected: `fflate` (we would still have to build the checks on paths, sizes and names ourselves, and it reads forms that `pack` never writes) and `tar.gz` (departs from the design, cannot be opened by double-click on Windows).

**Checked twice.** `pack` only packs if `check` reports no errors (warnings are allowed). The server cannot run `check` itself, because `check` runs game code in Node workers; so before every installation the server checks: the checksum from the catalog, structure and limits of the ZIP, the manifest including the SDK range, that `id` and `version` match the catalog entry, loading `game.mjs` in the sandbox, and one bot match each with the smallest and the largest allowed player count (at most 300 moves) in the sandbox. An error aborts the installation with a message in the admin dialog. Rejected: loading only, without a trial match (a package that fails on the first move would only be noticed in the first room) and the full `check` in QuickJS on the server (occupies the only sandbox worker for minutes).

**The catalog is a JSON file over HTTPS.** It is maintained in a Git repo; the server reads only the file, for example via the raw URL. It loads it when the catalog is added, at the push of a button and once a day, checks shape and size (at most 1 MB) and keeps the last good version if loading fails. Catalogs and packages come only via `https`; `http` is allowed only to `localhost` and loopback addresses (tests, development). The server follows redirects at most five times and only to `https`, because GitHub releases redirect.

```json
{
  "format": 1,
  "name": "Gamehearth",
  "games": [{
    "id": "mau-mau",
    "name": "Mau-Mau",
    "description": "Kartenspiel für 2–6",
    "repository": "https://github.com/hearthbit/gamehearth-mau-mau",
    "versions": [{
      "version": "0.1.0",
      "sdk": "^0.1.0",
      "mode": "turn-based",
      "players": { "min": 2, "max": 6 },
      "roles": { "player": { "inputs": ["touch", "mouse"], "screen": "small" } },
      "license": { "code": "MIT", "assets": "CC0-1.0" },
      "size": 812345,
      "url": "https://github.com/hearthbit/gamehearth-mau-mau/releases/download/v0.1.0/mau-mau-0.1.0.zip",
      "sha256": "…"
    }]
  }]
}
```

A catalog may list several versions of a game. New entries are written by the command `gamehearth catalog add catalog.json <package-url>`: it downloads the package, checks it like the server does, computes size and checksum and adds the version. Committing is done by hand; the CI of the catalog repo checks the file on every push. Rejected: the server clones the repo (git in the image, more attack surface) and a CI that automatically opens PRs against the catalog (a token with write access in the game repo, does not fit other people's games).

**Trust.** Now that the server has its sandbox, the risk is no longer the reducer but the client in the iframe: it sees everything its player sees, including the names of the other players, can show anything in its frame (including a fake login), and can reach outside servers via WebRTC despite the CSP (see "UI and game client"). The old rule "untrusted catalogs only without a reducer" does not protect against this, because games without a reducer in particular consist of nothing but client. Hence: **Adding a catalog means trusting it.** The dialog says exactly that and requires confirmation. A level "untrusted" only comes with the community registry. In addition, `webrtc 'block'` is in the games' CSP; browsers that know the directive close the gap with it. Anyone who opens a game file directly does not get it as a page of its own (see "Tightened after the review" below). Integrity is secured by the checksum in the catalog: a swapped release asset is rejected, a manipulated catalog is not. Signatures stay deferred. Rejected: two levels with a notice in the room (no longer protects anything technically, costs a second level everywhere) and cutting off WebRTC with an injected script (through an empty embedded iframe a game gets fresh constructors; a security measure that isn't one).

**No catalog by default.** A fresh server loads nothing without being asked. If the list is empty, the admin view suggests "Add Gamehearth catalog" ("Gamehearth-Katalog hinzufügen"), with the same dialog as for any other catalog. The URL is defined in one place in the code. Rejected: preconfigured (every self-hoster would trust the catalog without being asked) and only via an environment variable (a normal self-hoster would not find the URL).

**The admin view shows updates, installing happens on click.** If the catalog lists a newer version that fits the SDK, "Update to 0.2.0" ("Update auf 0.2.0") appears. The admin can also choose an older version to roll back a broken update. Running matches stay on their build, new rooms and new rounds take the new one. An installed game belongs to the catalog it came from and gets updates only from there; the same `id` from another catalog replaces it only after a confirmation prompt. Rejected: installing automatically (a broken release reaches everyone without anyone doing anything) and a switch per game (state and tests for a case that hardly occurs in our own circle).

**Removing lets matches play to the end.** The game disappears immediately from the game list for new rooms, and its lobbies are closed. Running matches play to the end; after that there is no new round, and the room shows "Game no longer installed" ("Spiel nicht mehr installiert") and can only be left. This also applies to finished rooms. If the game is installed again, things continue there as normal. The server deletes the files of a build as soon as no room uses it any more and it is not the current one; this also cleans up old builds after updates. The dialog first shows the number of affected rooms. Rejected: closing everything immediately (ends matches that have been running for days) and allowing removal only when there are no rooms (the admin would have to clear them first).

**A removed catalog does not take its games with it.** They keep running and appear in the list as "without catalog" ("ohne Katalog"), without updates; the admin removes them one by one if needed. An accidentally deleted catalog or a changed URL thus costs no running match. Rejected: the games go along (one click clears a lot) and allowing removal only when there are no games (cumbersome when a catalog moves).

**Admin view.** A new section "Games" ("Spiele") shows the installed games with version, source (catalog, "local" ("lokal") or "without catalog"), number of rooms and storage used, with update, choice of version and removal; below that the catalogs with URL, last update or last error, "Refresh" ("Aktualisieren") and "Remove" ("Entfernen"); then the not yet installed games of all catalogs with "Install" ("Installieren") (player count, license, size, link to the repo); finally the storage of all builds and the free space on the disk.

**`GAMES_DIR` only for development.** The server now keeps track of installed games in the database. `GAMES_DIR` only has an effect if it is set: games from it are built from source on every start as before, are called "local" in the admin view and can neither be updated nor removed there. If the same `id` exists in the folder and in a catalog, the folder wins, and the view says so. The Docker image no longer sets `GAMES_DIR` and ships no games. Rejected: dropping `GAMES_DIR` entirely (until `dev` exists, every change during development would need a new package) and a folder with prebuilt ZIPs (in the monorepo you would have to pack before every start).

**Not in step 7:** starter repo, `new` and `dev` (separate step 7b), uploading packages without a catalog, untrusted catalogs, signatures, migration of running rooms.

**Settled while building** (details in [packages/server/README.md](../packages/server/README.md#games-and-catalogs) and [packages/devtool/README.md](../packages/devtool/README.md#pack)):

- The manifest has two optional fields for the catalog: `description` (up to 200 characters) and `repository` (`https` URL of the source code). `catalog add` takes them from the newest version.
- On an update, lobbies move to the new build immediately, because no match is running there yet; starting a match always takes the current build. Running and finished rooms stay on theirs.
- If the host aborts a running match of a removed game, the room closes instead of going into a lobby that could never start again.
- The trial match picks random legal moves and may take at most 30 seconds. Local games from `GAMES_DIR` play no trial match, so that broken games can also be started for trying out.
- Installing and cleaning up builds run one after the other, so that cleanup does not delete a build that is just being written. Cleanup also removes temporary folders older than one hour.
- The remove dialog fetches the room counts fresh from the server instead of showing those of the last loaded view.
- `pack`, `catalog add` and the server share the reading and checking of a package (`inspectPackage`); so the catalog command rejects the same packages as the server.
- The dev tool goes into the game and catalog repos as a tarball with `dist/cli.js` including a shebang; otherwise `npx gamehearth` does not start outside the monorepo. `npm pack` builds `dist/` itself first (`prepack`).

Tightened after the review (2026-11-17):

- **Game files only embedded.** If someone opened a game file directly (`/games/<id>/<build>/`), it ran as the top-level page on the platform's domain. The sandbox CSP took away its storage and cookies, but not its own navigation: a fake login under the real address could have passed input on via `location = …` in every browser, not only via WebRTC. The server therefore does not serve game files when the browser loads them as the top-level page (`Sec-Fetch-Dest: document`), but answers with 403 and a short notice, itself again with the sandbox CSP. Browsers without this header (before 2023) stay with the old sandbox. In the platform's iframe, `frame-src 'self'` still prevents redirecting (browser test).
- **Packages over `http` only from catalogs on localhost.** A catalog served over `https` may not name `http` URLs of loopback services as a package; otherwise it could make the server send requests to services on the server itself when someone clicks "Install".
- Cleanup determines the builds in use only when its turn comes, not when it is queued. Otherwise, after a long installation, it could delete the build of a match that had started in the meantime.
- Removing a game and removing a catalog are not possible while an installation is running (`install-busy`); otherwise a removed game was back after the installation, and a removed catalog led to an internal error.
- The server sorts the versions of a catalog itself, in descending order; a hand-maintained catalog may list them in any order.
- After installing another version, the admin view preselects an offered version again instead of sending the just installed one again.

### Repos

| Repo | Content | License |
|---|---|---|
| **Platform** (monorepo) | Server, PWA client, SDK, dev tool | AGPL-3.0 for server and client, MIT for SDK and dev tool (each package has its own LICENSE file) |
| **Starter** (template repo) | Snapshot of what `npx gamehearth new` creates: example game, `AGENTS.md`, docs; uses SDK and dev tool as npm packages (since step 7b, see "Starter, `new` and `dev`") | MIT |
| **One repo per game** | Created from the starter; CI builds the game package (ZIP) and attaches it to a release | Author's choice (OSI license for code, CC0/CC-BY/CC-BY-SA for assets) |
| **Catalog** | Only the index with name, version, roles and devices, size, download URL and checksum; no game code | CC0 |

- **Server, client, SDK and dev tool together:** In the beginning the protocol between SDK and server changes all the time. In one repo, such a change lands on both sides in one commit and is tested together. Licenses per package are no problem in the same repo.
- **Catalog only as an index:** Adding a game means opening a small PR against the catalog. The catalog stays small no matter how many games there are, and every game keeps its own license, authors and history.
- **One repo per game already in the MVP:** Our own three games go through the same path as community games later (create from the starter, build a release, catalog entry, installation on the server). Errors in the publishing path thus show up before the first outside contribution.
- **Interim solution until step 7:** As long as there is neither a starter repo nor game packages, the MVP games live under `games/` in the platform monorepo, so that `check` and the server can use them directly. In step 7 each one moves to its own repo; that is also the first run of the publishing path.
- Rejected: one shared games repo for the start (less maintenance, but the publishing path would stay untested) and game code directly in the catalog repo (one repo for all contributors, grows with every graphic).

Decided on 2026-11-17 before step 7:

- **Game and catalog public, platform still private.** `hearthbit/gamehearth-mau-mau` (MIT, graphics CC0) and `hearthbit/gamehearth-catalog` (CC0) are public, so that the server and CI get by without credentials. The platform repo stays private until that is decided separately (see "Still open"). Rejected: everything private with a token per catalog in the database (more code, a secret in every backup) and everything public right away (goes beyond step 7).
- **SDK and dev tool as tarballs in the game repo.** As long as the platform is private, `@gamehearth/sdk` and `@gamehearth/devtool` live as `npm pack` tarballs in `vendor/` of the game repo and are included via `file:`. When the platform is opened, they go to npm. Changed before step 7b: they go to npm already now, the dev tool as `gamehearth` (see "Starter, `new` and `dev`").
- **Mau-Mau moves** to a fresh repo with a reference to the platform repo, without the platform's private history. On a tag `v…`, CI builds a release with `check` and `pack`, with the package attached. In the monorepo, `fixtures/mau-mau` remains as a **frozen test copy** for server, `check` and browser tests; it only changes when tests need it. Rejected: rewriting the tests for a new small test game (around 25 test files, risk of losing coverage).
- **Starter repo, `new` and `dev` become step 7b.** The Mau-Mau repo is the first draft of the starter, without templates and without `dev`. Rejected: everything in step 7 (too big for one pass and one review) and the starter without `dev` (would have to be touched again for `dev`).

### AI-assisted game development

There is **no LLM in the platform.** Instead there is a **starter repo** that you open with any AI agent (Claude Code, Cursor, Copilot …):

- `AGENTS.md` with the rules of the reducer contract, the state structure and the manifest
- SDK docs, short and complete: the smaller the API, the less often the AI makes things up
- templates for the three kinds of games (turn-based, realtime, free single player)
- the three MVP games as examples
- dev tool with these commands:
  - `new` creates a game from a template (step 7b)
  - `dev` starts the game locally with several players in the browser (step 7b)
  - `check` checks manifest, licenses, reducer purity and plays matches automatically
  - `pack` builds the game package after a green `check` (step 7)
  - `catalog add` adds a package with size and checksum to a `catalog.json` (step 7)

An AI construction kit in the platform is deferred. Requirement for it: later it should use the same templates and the same `check`.

### Starter, `new` and `dev`

Decided on 2026-11-17 in a grilling session before step 7b.

**SDK and dev tool go to npm, the platform stays private.** Until now both lived as tarballs in `vendor/` of every game repo. Their source code is thus already public (MIT), but an outsider can never update them on their own, because new tarballs only come out of the private platform repo, and `new` would have no place to start from. With npm, `npx gamehearth new my-game` is enough on any machine, and games update via `npm update`. The npm account (with 2FA) and the organization `gamehearth` are set up by the maintainer; publishing happens only after the maintainer's OK. When the platform repo becomes public remains a separate decision (see "Still open"); until then the repo link of the npm packages points to the starter repo. Rejected: opening the platform now and rewriting its history for that (the biggest decision would be made in passing) and continuing with tarballs and the starter as a GitHub template (everything `new` would need for that would become obsolete with npm).

**Postponed on 2026-11-17:** npm and the public starter repo wait until more of our own games are built (they came with step 16, see "Publication (step 16)"). Until then our own games are created with `new --local-packages <folder>`, with SDK and dev tool as tarballs in `vendor/`, as with Mau-Mau. The starter repo exists only locally, because its CI fails without the packages on npm.

**The dev tool is called `gamehearth` on npm**, the SDK stays `@gamehearth/sdk`, because all games import it under that name. Anyone who types `npx gamehearth` outside a game fetches the package with exactly this name; if it does not belong to us, someone can squat it and have foreign code run. Server, browser tests and game repos follow suit. The dev tool starts under the new name as 0.2.0, the SDK stays 0.1.x. Rejected: `@gamehearth/devtool` with a package `create-gamehearth` (three packages, and `gamehearth` would still have to be taken as a placeholder) and only `@gamehearth/devtool` (cumbersome, and `npx gamehearth` would stay free).

**The templates live in the dev tool, the starter repo is a snapshot of them.** `new` copies the template from the installed package, so it works offline and always matches the version of SDK and dev tool; in the monorepo the template is tested with exactly this SDK. `hearthbit/gamehearth-starter` (MIT) contains exactly what `new` creates, written by a script in the monorepo and marked as a template on GitHub ("Use this template", Codespaces). It is the public place for docs and issues about SDK and dev tool as long as the platform is private. Rejected: no starter repo at all (outsiders would find only Mau-Mau and the catalog on GitHub) and the starter repo as the source that `new` downloads from GitHub (needs network, and template and SDK could drift apart).

**One template: turn-based with Phaser 4.** Realtime needs `tick` (comes with game 2), and games without a reducer cannot be installed until game 3. `new` nevertheless already knows `--template`, so that both can be added without rework. Rejected: a second, plain template without an engine (departs from "Phaser for everything", double maintenance).

**The template is a small, complete game:** "Card Duel" for 2–4 players. A secret deck, a hidden hand; everyone plays a card face down at the same time, then the cards are revealed, the highest wins the round, the game ends after five rounds, ties included. It shows all three state areas, a hidden choice without a leak, randomness and the end of the game, plus rule tests, UI logic without Phaser (`view.ts`) and keyboard controls. Tests, `check` and `dev` are green from the first minute. Agents pick up patterns from code more readily than from docs. Rejected: a tiny game with only open information (hidden information, the biggest risk in AI-made games, would only be covered in the docs) and an empty skeleton (red until the agent writes something).

**`new` asks no questions.** `npx gamehearth new <folder> [--name "Connect Four"]` takes the `id` from the folder name and the rest from the template, runs `npm install` and `git init` (without a commit) and lists the next steps; `--no-install` skips the installation. Often it is not the person who types but their agent, and agents get stuck on prompts. The agent changes player count and rules anyway when it replaces the example. Rejected: prompts in the terminal (two paths to test, and the player count would then no longer match the rules of the example) and only copying (one more step before you see anything).

**License: MIT for code, CC0 for graphics, preset.** The copyright holder in `LICENSE` is `git config user.name`; if that is not set, "the authors of <game>". `AGENTS.md` requires the agent to ask the person about license and name before the first release and to explain what that means. Rejected: flags for other licenses (license texts to maintain, mostly useful to programmers) and a placeholder that `check` reports as an error (red from the first minute).

**Content of a new game repo** (like Mau-Mau, but with npm instead of `vendor/`): `manifest.json`, rules under `src/`, Phaser client under `client/`, tests under `test/`, `AGENTS.md` and `CLAUDE.md`, `README.md` for humans, `LICENSE`, CI for types, tests, build and `check`, and a release CI that on a tag `v*` builds the package with `check` and `pack` and attaches it to a release. All texts are German, like the SDK docs, `check` and the platform; a translation comes when the platform addresses a community, and then for everything.

**`AGENTS.md` stays short, the contract comes from `node_modules`.** The repo contains only things that do not change with an SDK update: the workflow (changing rules, tests, `dev`, `check`, `pack`), the most important rules, typical mistakes, how to work with a person who doesn't program, and how to replace the example completely. For details it gives fixed paths to the READMEs of SDK and dev tool in `node_modules`, which move along with every update. A `CLAUDE.md` containing only `@AGENTS.md` makes Claude Code, which does not read `AGENTS.md` on its own, load it. A test in the monorepo checks that the named paths and commands exist. Rejected: the whole contract in one big `AGENTS.md`, and several doc files in the repo (both go stale in the repo after an SDK update).

**Publishing via your own catalog.** The starter README and `AGENTS.md` show the way to your own catalog: a repo with `catalog.json`, `npx gamehearth catalog add … --name`, the raw URL in the admin view of your own server. For now the Gamehearth catalog only takes our own games, because every server that uses it trusts its games; a path for outsiders comes with the community registry. Rejected: PRs from outsiders to the Gamehearth catalog (trust and review would depend on one person).

**`dev` is a small server of its own in the dev tool (MIT).** It uses `node:http`, a host page with the seats, and the same sandbox core as the server: the reducer runs in QuickJS, in a worker with a hard time limit, so that an infinite loop does not freeze `dev`. The game runs in an iframe with the same sandbox and CSP as on the platform. The match lives only in memory; there is no login and no lobby. The bridge to the iframe is newly written and tested against the client SDK. Rejected: embedding the platform server (AGPL in the MIT package, database and login for every seat) and computing the reducer in the browser (V8 instead of QuickJS, differences would only show up in `check` or on the server).

**All seats side by side.** The page shows every seat in a phone-sized frame, the player count can be chosen at the top, and "New match" starts over. Every seat also has its own address (`/p2`) for a second window or, with `--host`, for a phone on the Wi-Fi. Errors with hidden information are easiest to spot when all views are in front of you at the same time. Rejected: one frame with seat switching (never two views at the same time) and only one window per seat.

**Reloading means replaying.** When the rules under `src/` change, `dev` bundles again and replays the same match from seed and moves with the new code; you are back at the same point. If a move is no longer legal or the code throws, `dev` stops there, gives the reason and offers "New match". If only the client changes, `dev` reloads the frames. The client is built by the game's own command (`--build "<command>"`, in the template `vite build --watch`), so that the same built client always runs as later on the server. Rejected: every change starts a new match (a position after 20 moves would have to be played again every time) and keeping the state while swapping the code (creates states the game would never create).

**Also included right away:** every seat can be set to "Bot" and then makes a random legal move after a short pause. Under every seat, collapsible, is the snapshot its client receives, plus the whole state including `secret`, the seed and the moves. Errors from the sandbox appear with phase, seat, move and location in the source code as a banner and in the terminal; errors and `console` output from the iframe are collected by a small injected script; the text is worded so that you can paste it to the agent. Deferred: taking back a move.

**Test before npm.** As long as nothing is on npm, `new`, `dev`, `check` and `pack` run in a fresh folder outside the monorepo with locally packed tarballs (`new --local-packages <folder>`).

**Acceptance run by agents with no prior knowledge.** An agent gets only a folder freshly created with `new` and a request as a person who doesn't program would type it. First Connect Four (Vier gewinnt); whatever snags goes into the template and the docs. Then a fresh agent with a game with hidden cards, which shows whether the fixes hold and whether the rules on hidden information get through. The run passes when tests, `check` and `pack` are green and the game plays through in `dev` with two players in a browser test.

**Settled while building** (details in [packages/devtool/README.md](../packages/devtool/README.md#new)):

- The platform root is named `gamehearth-platform`, so that it does not have the same name as the dev tool's workspace. The dev tool requires the SDK as `^0.1.0`, so that npm installs only one copy in a game.
- The template is named `turn-based` and lives under `packages/devtool/templates/`. It is a complete game (`id` `card-duel`); `new` fills in `id`, name, versions and license. Files that npm does not publish (`.gitignore`) or that would get in the way (`.github`) are stored there without the dot and get it when the game is created. In the monorepo, the template's tests, type check and `check` run along.
- `npm run check` and `npm run pack` of the template build the UI first. In the first test run as an outsider, `check` otherwise failed on the unbuilt client.
- `dev` listens on port 5180 (if taken: the next free one) and only on `127.0.0.1`, with `--host` on all addresses. The host page receives updates via server-sent events and sends moves, bots and new matches via `POST`; `dev` accepts those only with the `Origin` of its own page and as JSON. The hard limit in the worker is 2 seconds (500 ms on the server), because `dev` should also serve slow machines; QuickJS's own time limit is 100 ms, as on the server.
- `dev` detects new builds of the UI by the `index.html` of the client folder (polled every 300 ms), not with a file watcher: this works with any build tool and also when the folder is recreated during the build. The template's watch build writes to `dist/dev-client` with source maps, `npm run build` for the package writes to `dist/client` without them.
- Errors from the iframe are collected by a script that `dev` inserts as the first script into every served HTML file of the game (`__gamehearth-dev.js`, from the game's own build folder, so that the CSP stays the same). The host page passes them on to `dev` together with the seat.
- The seats are named Anna, Ben, Clara and so on. Bots stay on after "New match". A move that hits an outdated snapshot is rejected as `stale`, as on the server.
- `npm run starter -- ../gamehearth-starter` writes the snapshot of the starter repo as "My Game", with its own README for the repo's front page. It does not write the machine's git name into the `LICENSE`; it says "the authors of My Game" there.

From the two acceptance runs (2026-11-17, Connect Four and Old Maid (Schwarzer Peter), both passed):

- The built-in browsers of some AI tools do not load sandboxed iframes without an origin of their own (the browser pane of the Claude app blocks every request from such a frame). `dev` nevertheless stays as isolated as the platform; `AGENTS.md` says how an agent checks in that case, and that it must say in its handover if it has not seen the UI. Rejected: a second view without isolation on another origin (differences from the platform, such as `localStorage`, would slip through).
- `AGENTS.md` got patterns for empty player areas, taking turns in order including skipping, card games with identical cards (distinct names, drawing only by position after shuffling) and the type error with move literals.
- `check` reports matches with several winners, because otherwise the win rates add up to over 100%.

Tightened after the review (2026-11-17, regression tests in `packages/devtool/test/dev.test.ts`, `dev-review.test.ts`, `new.test.ts`, `starter.test.ts` and `e2e/dev.e2e.ts`):

- A bot move cleared the error banner that a human had triggered; now only a successful move by a human clears it. If a bot's move fails on the game code, that bot stops instead of producing the error again every 700 ms; the same error appears only once in a row in the terminal.
- If a new build could not be loaded in QuickJS (for example `console.log` at the very top), the old one was already discarded, and every move failed. Now the worker builds the new sandbox first and replaces the old one only on success.
- Stacks from Firefox and Safari (`name@address:line:column`) lost their location in the source code.
- Ctrl+C ended `dev` immediately via the handler of `check`, without ending the build process. If the start failed (port taken, wrong player count, invalid port), the build process and the worker kept running. Everything `dev` starts is now cleaned up through a shared list, both on exit and on an error at start; on Linux and macOS it ends the whole process group of the build. The worker file no longer lives in a temp folder per run but in a cache per build, so that a hard kill (`taskkill /F`) leaves nothing behind.
- `dev` now only answers under `localhost`, IP addresses and `*.app.github.dev` (against DNS rebinding: otherwise a foreign web page could have read the state including `secret` and written text into the terminal that an agent reads). The origin is compared without the scheme, also against `X-Forwarded-Host`, so that `dev` works behind HTTPS. Text from the iframe reaches the terminal without control characters. With `--host`, `dev` warns that everyone on the Wi-Fi sees and controls everything.
- `dev` and `check`/`pack` built into the same folder `dist/client`: `check` deleted the watch build's source maps, and `pack` could pack files of a half-finished watch build. For `dev`, the template now builds into `dist/dev-client` (option `--client`).
- An explicit `--port` no longer silently falls back to another port; without it, `dev` says which port it uses instead of 5180. `AGENTS.md` says that the address in the output is the one that counts.
- "New match" reloads the frames, just as the platform rebuilds the iframe for each round.
- `npm run starter` writes only into an empty folder or an existing snapshot (before, `npm run starter -- ..` would have deleted all neighboring projects) and creates the `package-lock.json` as soon as the packages are on npm; the starter's CI needs it.
- `new` names the right folder even if it starts with the name of the working folder, and keeps names containing `$` unchanged.
- Known limitation: `dev` has not been tried in GitHub Codespaces.

### Realtime, roles and TV

Decided on 2026-11-17 in a grilling session before step 8. Extends the sections "Realtime" and "Roles and devices" above.

**Game 2 is "Farbfelder" (color fields).** 2–8 players run across a grid with a d-pad and color every cell they step on in their color; a splat button colors 3×3 cells at once and recharges for 8 seconds. After 90 seconds the largest area wins. The TV shows the field, the phones are controllers. Nobody is knocked out, the end comes through time, and the steady movement shows whether the smoothing holds up. The logic stays a grid and is therefore easy for agents to change. There is no sound. Rejected: light snakes (simplest controller, but players who are out just watch) and an ice floe with physics (the hardest example for agents and more prone to calculation differences between engines).

**Two steps.** Step 8 is the platform: `tick` in the SDK, realtime rooms in the server, pairing the TV, roles and devices in the client, help with smoothing in the client SDK and `check` for realtime, tested with a test game in the monorepo. Step 8b brings the template "realtime", `dev` with a TV frame and Farbfelder in its own repo. Each step gets its own review. Rejected: a single step (too big for one review) and three steps (pairing could only be tried out on a real game in the last one).

**The template has its own small game: "Tag"** for 2–6 players, with TV and controllers. One player is the catcher ("it"); whoever they touch becomes the catcher. After 60 seconds, whoever was the catcher for the shortest time wins. Farbfelder is created from it with `new --template realtime` and so tests the path "replace the example completely" the way an outsider would take it. Rejected: a plain version of Farbfelder as the template (the path "replace the example" would stay untested) and Farbfelder itself as the template (every improvement to the game would change the template for everyone).

**`tick` is a fifth, optional function.** `tick(state, dt, ctx)` exists only with `mode: "realtime"`, and there it is required; `check` reports a `tick` in a turn-based game and a realtime game without one. The tick rate is fixed at 20 Hz, `dt` is always 50 (milliseconds), so that every match stays reproducible from seed and inputs. `ctx` has `players`, `random` and `now`. `tick` may change the state like `apply`. The rule "nobody can move without the match ending" does not apply to realtime, because ticks carry the match forward (for example a countdown without inputs). The match counts the ticks, and snapshots carry the tick number. Rejected: a tick rate per game in the manifest (more variants in server, `check` and `dev`, without any game needing it).

**Inputs are moves, collected until the tick.** Controllers keep sending `move`, in realtime without a version check, because the version goes up with every tick. The server collects a room's moves until the next tick and then, in one sandbox call, runs `apply` for each move in order of arrival, each against the `legalMoves` valid at that point, and then `tick`. The response to `move` comes with this tick. `legalMoves` describes the inputs allowed right now. A game thus knows only the one concept "move", and `check`, bots and the leak check work as before. Rejected: a held input state per seat that `tick` receives (a second concept next to moves) and every input immediately as its own sandbox call (a multiple of the load).

**A regular snapshot is stored.** A running realtime match lives in memory. The server writes it to SQLite at the start, every 10 seconds, at every pause and at the end; individual ticks and inputs do not go into the history. After a restart the room stands paused at the last snapshot and continues as soon as everyone is back; at most 10 seconds are lost. Rejected: not storing at all (annoying for longer realtime games built from the template) and storing every tick (20 writes per second and room).

**Pause when a seat or the TV is missing.** The match pauses when a seat has no visible connection (a locked phone counts as empty, even if the connection is still alive) or a game with role `screen` has no connected TV, each after a 2-second grace period against short dropouts. When everyone is back, it continues after a 3-second countdown. The host can also pause and resume from the menu. During a pause no ticks run; the platform keeps inputs (since the review: the last one per seat, applied in the first tick afterwards). A game with role `screen` only starts when a TV is connected. Rejected: pausing only for a missing seat and without a countdown (whoever locks their phone keeps running and loses) and pausing only by button.

**An error in `tick` pauses the match.** The room stays at the last valid state and shows "An error occurred in the game (incident …)" ("Im Spiel ist ein Fehler aufgetreten (Vorfall …)"). The host can abort or try again; the quarantine of a build kicks in after repeated aborts as before. Rejected: aborting the round automatically (you lose it without a choice) and skipping the tick (a persistent error would flood the log and the quarantine counter 20 times per second).

**The TV is paired by code.** It opens `/tv` without logging in and shows a code plus a QR code. A member scans it with their phone or types the code in the lobby and so pairs the TV with the room. The TV gets its own screen session for this room only: no account is logged in on the shared device, and it sees only what all members see (the public state and the names). It takes no seat and does not count toward the player count. In the lobby it shows the code and the QR code for joining in large size, during the match the game in the role `screen`. Everything is operated from the phone. Rejected: the room on a second device of the member (an account with full rights would have to be logged in on the TV) and the TV as a member with a screen role (typing names on the TV; a host who plays along on their phone would need two identities).

**Any member may pair, the pairing belongs to the room.** At most 4 TVs per room; they are listed in the lobby, visible to everyone (built as a separate card "TV" ("Fernseher") next to the member list), and the host can remove them there. The pairing lasts across new rounds and ends with the room or after 24 hours without a connection. A planted code (someone shows the code of their own device) only gives a view of public information, and the list shows every TV. TVs exist only for games with role `screen`. Rejected: only the host, with one TV (otherwise nobody could re-pair a crashed TV) and a pairing until the end of the round (annoying with several rounds in one evening).

**Devices are labeled, not hidden.** The game list shows each game's roles as devices ("TV + phones" ("Fernseher + Handys"), "everyone on their own device" ("jeder am eigenen Gerät")). If the device fits no role by width and pointer type, a hint is shown; creating a room still works. On large devices the lobby suggests using the device as a TV. The browser cannot detect a keyboard, and a gamepad only after a button press; the device manifest therefore stays a hint, not a block. Rejected: hiding games (a laptop with touch or a tablet with a keyboard would see wrong lists) and a filter to switch on (hardly anyone would find it, and detection would stay just as unreliable).

**The client SDK helps with smoothing.** The server sends 20 snapshots per second, screens draw 60 and more frames. The SDK buffers the snapshots with their tick number and delivers two snapshots and a blend value per frame (`from`, `to`, `alpha`, about 100 ms behind the newest snapshot), plus `lerp`. The game decides which fields it blends; the template shows the pattern. Rejected: blending all numbers automatically (points and indices would turn into decimals) and no help at all (every game would build the buffer anew, a typical source of bugs).

**`check` with a game time limit.** Bots pick random legal inputs per tick. If a match does not end within 10 minutes of game time (changeable with `--max-seconds`), that is an error like the move limit for turn-based games; realtime games therefore need an end, for example a time limit. Fewer matches run than for turn-based games, and slow ticks in QuickJS produce a warning. Rejected: endless matches only as a warning (a forgotten end would go unnoticed).

**`dev` for realtime (step 8b).** A large TV frame next to the phone frames, separate addresses `/tv` and `/p2` for real devices with `--host`, ticks at 20 Hz, bots with random inputs and a view into state and snapshots. Plus "Pause", "One tick" and slow motion at half and quarter speed. If the rules change, a new match starts with the same seats and bots. Rejected: replaying on rule changes as for turn-based games (the same inputs quickly play out differently under new rules; you would not end up at the same point anyway).

**Acceptance run.** An agent with no prior knowledge gets only a folder created with `new --template realtime` and a request the way a non-programmer would type it: "Build Farbfelder" ("Bau Farbfelder"). Whatever snags goes into the template and `AGENTS.md`. After that the game is brought up to catalog level. It is accepted when tests, `check` and `pack` are green in the game repo and a match with a TV and two phones runs through on the platform in a browser test. Rejected: building the game only ourselves (template and `AGENTS.md` would only be checked by someone who knows the platform) and an additional acceptance game (the most expensive).

**Not in step 8 and 8b:** joining running matches (rounds are short, people join in the lobby between rounds), prediction with rollback, a tick rate per game, bots for empty seats on the platform, TVs for games without role `screen`, sound and replaying in `dev` for realtime.

**Settled while building step 8** (details in [packages/sdk/README.md](../packages/sdk/README.md#realtime), [packages/server/README.md](../packages/server/README.md#realtime) and [packages/client/README.md](../packages/client/README.md#realtime-and-tv)):

- The SDK is now 0.1.1; realtime games require at least `"sdk": "^0.1.1"` in the manifest so that older servers do not install them. Turn-based games with `^0.1.0` run unchanged.
- `stepMatch(game, match, { inputs, now, dt })` is one step: inputs in order, then `tick`. `version` and `tick` go up by exactly 1 per step, so that the host can check the sandbox output exactly as before. An input that is not allowed gets its error code without holding up the step; an error in the game code, also in `apply`, makes the whole step fail and pauses the match. If the match ends through an input, no tick runs anymore.
- The client SDK gives TVs the role only if the game calls `connect({ screen: true })`; otherwise `connect` refuses them with an explanation. Existing games thus change nothing in their types. A TV gets its own connection without a seat and without `move`.
- The tick timer catches up on late ticks, at most 200 ms behind; a busy machine therefore does not slowly slow down game time (found in the browser test, when three browsers and the server ran on one machine). Inputs during the countdown count for the first tick.
- In realtime rooms the server checks the connections by ping every 5 seconds instead of every 30. A phone that drops out of the Wi-Fi without logging out thus pauses the match after 5 to 10 seconds, not only after a minute (also found in the browser test).
- After each tick every connection gets only one `frame` with its snapshot, not the whole room; a connection with more than 64 KB of unsent data skips frames instead of being disconnected.
- The QR code on the TV leads to `/pair#CODE`, where you choose the room; in the lobby there is also "Use this device as TV" ("Dieses Gerät als Fernseher nutzen"), which pairs a device without a code (for example a laptop connected to the TV). A device belongs to at most one room; a new pairing moves it.
- In the monorepo the test game "Wettlauf" (race; `fixtures/wettlauf`, TV and controllers, one button) tests server, `check` and browser tests; like Mau-Mau it only changes when tests need it.

Tightened after the review (2026-11-18, regression tests in `packages/server/test/realtime.test.ts`, `screens.test.ts` and `packages/client/test/realtime.test.tsx`):

- Unknown rooms when pairing a TV count as a failed attempt for the address. Otherwise someone with their own TV code could have probed without limit which room codes exist and entered a lobby they found as a guest.
- At most 4 unpaired TVs per address and 100 in total, 30 code requests per minute and address; if the list of open codes is full, a new device gets no code instead of pushing out the oldest one. Before, anyone with a made-up device cookie could keep connections open without a time limit and so take up all of the server's slots or invalidate the codes of real TVs.
- Inputs during a pause are no longer rejected; instead the last one per seat is kept and applied in the first tick afterwards; with too many inputs the oldest is dropped instead of the newest. Otherwise a release during the pause was lost, and the character kept running after the countdown although nothing was pressed.
- If the session ends on a device that is also a TV, the TV stays connected. The pairing code states its remaining lifetime, so that a TV with a wrong clock renews it in time. Rooms without connections keep no presence entry. In realtime, rate limiting does not show up as a hint on every input.
- Known limitation: during a match the UI does not show the TVs; removing them works in the lobby. A crashed TV can be re-paired at any time via its QR code.

**Settled while building step 8b** (details in [packages/devtool/README.md](../packages/devtool/README.md#dev)):

- The dev tool is now 0.3.0. `new --template realtime` creates a game from the template "realtime"; the default stays `turn-based`.
- Tag computes in whole grid units with integer speed and compares squared distances, so that server (QuickJS) and `check` (Node) compute the same; `AGENTS.md` makes this a rule. Inputs are held directions (`steer` with `up`, `down`, `left`, `right`, `none`), as the SDK docs recommend.
- When the rules change, `dev` starts a new match with the same seed, so you see the same starting setup with the new rules. The countdown and the platform's pauses (missing phone or missing TV) do not exist in `dev`; it pauses only by hand or on an error. For realtime the list of moves shows only the latest inputs, and state and snapshots are only rewritten 20 times per second in expanded sections.
- The TV frame in `dev` is 640 × 360 pixels (landscape), the phones stay 360 × 640.

From the acceptance run (2026-11-18: an agent with no prior knowledge built Farbfelder from `new --template realtime`, tests, type check and `check` green, looked at the UI itself via remote-controlled Chrome; regression tests in `packages/server/test/realtime.test.ts`, `packages/devtool/test/check-realtime.test.ts`, `dev-realtime.test.ts`, the template and `e2e/dev-realtime.e2e.ts`):

- A single tick over 100 ms, for example because the machine was briefly busy, paused the match on the server and made `check` report an error, although the game needs only 1 to 5 ms per tick on average. After a timeout (the server also after too much memory or a restart of the worker), server and `check` recompute a tick once on a fresh sandbox and only stop the second time.
- Under load `dev` dropped ticks (measured 16 instead of 20 per second); it now catches up on them like the server.
- In the single view of `dev` (`/p1`, `/tv`) the frame extended below the visible area; a broken build did not show the actual message in the error block. Both fixed.
- The template's d-pad now takes the direction from the finger's position relative to the center, so that the thumb can slide from one direction to the next (that is how the agent had built it for Farbfelder).
- `AGENTS.md` no longer lists `Math.sqrt` among the inexact functions (that contradicted the SDK docs), searches for leftovers more specifically, says that `check` takes a few minutes for realtime (intermediate runs with `--players 2`), and how to reach isolated frames with Playwright and via the DevTools protocol. The SDK docs describe the shape of `results` from `stepMatch` and that `players` in the snapshot are the seats in the order of `ctx.players`.
- Deferred: a command that delivers screenshots of all frames from `dev` (`dev --screenshot`), so that agents without their own browser can see the UI.

Tightened after review 8b (2026-11-18, reviewer with no prior knowledge of `dev`, template, Farbfelder and docs; regression tests in `packages/devtool/test/dev-realtime.test.ts`, `dev.test.ts`, `new.test.ts`, `packages/sdk/test/client-realtime.test.ts`, `packages/server/test/realtime.test.ts`, `sandbox.test.ts`, the tests of the template and of Farbfelder):

- While paused or after a tick error, `dev` queued inputs without answering them; a UI waiting for the answer got stuck. `dev` now answers them right away and takes the last one per seat into the next tick, like the server during a pause. With more than four waiting inputs the oldest is dropped, as there, and `dev` rejects more than 30 inputs per second and seat.
- `dev` recomputes a tick once after a time, memory or crash error and calls a failed tick "Tick N failed" instead of "Cannot create the match". While new rules load, the tick timer stands still, so that no tick applies the new rules to the old state. `dev` reports disallowed inputs only if they were already disallowed on arrival.
- The TV frame in `dev` only got a snapshot for realtime games; now for every game with role `screen`.
- In `dev`'s slow motion the smoothing kept computing with 50 ms per tick and stuttered. The bridge can send a tick duration `tickMs` along, and `createTimeline` follows it (SDK 0.1.1, additive only).
- The server still counted a tick that succeeded on the second attempt after a timeout as a soft abort; ten outliers in ten minutes would have quarantined the build for all rooms. Only a final failure counts now. After an abort at the hard limit the server no longer recomputes (since the acceptance run this also applied to a restart of the worker).
- If an input got lost (rate limiting, new round), the character in Tag and Farbfelder kept running in the wrong direction until you pressed again. The controls resend the held direction as soon as the snapshot shows something different and nothing is in flight anymore. Keys form a stack (hold left, tap up, keep going left); in Farbfelder only Enter steers on the d-pad buttons, the space bar stays the splat.
- Farbfelder read out the remaining time, which changes every second; now only the result is read out. The README linked to a starter repo that does not exist and to a command that does not exist without an npm package.
- The templates' `AGENTS.md` names the real input limits, the Playwright route to phone (`.seat:not(.tv)`) and TV (`.seat.tv`), and that after replacing, the original example lives under `node_modules/gamehearth/templates/<template>/`.
- Found when running all e2e tests again as a cross-check: an expanded snapshot in `dev` stayed empty until something changed again (since 8b only expanded sections are rewritten; for a turn-based match or paused realtime nothing came after that). It now fills when expanded. The bot test in `e2e/dev.e2e.ts` sometimes played a card in the next round in its retry loop and so skipped one; it now plays only in the expected round.

### Single player, saves and offline

Decided on 2026-11-18 in a grilling session before step 9. Extends "Single player" above and anticipates a piece of "Game data, options and profiles".

**Game 3 is "Mauerbrecher" (brick breaker).** Ball and paddle break down brick walls, portrait format for the phone. You drag the paddle with your finger or move it with the arrow keys, and launch the ball by tapping or with the space bar. 10 levels, 3 lives, bricks taking 1 to 3 hits and indestructible bricks; destroyed bricks rarely drop power-ups (wider paddle, second ball, slower ball). After level 10 the game is completed. There is no sound. The save holds level, points, lives, the remaining bricks and active power-ups; the best score is the points. It uses Phaser's arcade physics and its own game loop, exactly what a single-player game without a reducer may do. Rejected: solitaire (a real save, but no physics and no game loop) and an endless jumper (short rounds, hardly any save).

**Stored on the device and on the server.** The platform writes save and best scores to the device right away and syncs them with the server as soon as it is reachable. So nothing is lost offline, you can continue on another device, and the database backup covers everything. For best scores the better one wins, for the save the newer one by the clock of the device that saved it; the server caps timestamps in the future. If someone plays offline on two devices at the same time, the older save is silently lost; that is accepted. Rejected: only on the device (gone when switching devices, no comparison), only on the server (matches played offline would save nothing), asking on conflicts (dialog and state for a rare case) and "last upload wins" (a device lying offline for days would overwrite newer saves).

**One save document, and best scores as stats.** The save is one JSON document per account and game (at most 64 KB), which profiles do not have: a whole save fits neither into flags (200 characters) nor into stats (they cannot be set). Best scores, on the other hand, are already profile stats. The manifest declares them under `stats` with display name, direction and format; the platform applies `max` or `min` depending on the direction and rejects unknown names. The post-MVP profiles extend these stats without games having to be rebuilt. The save is valid across game versions; a game must read older saves or cleanly start over. Rejected: pulling profiles forward entirely (the post-MVP block would become part of step 9 and still not solve the save problem) and only one document in which the game puts its high score itself (the platform would know nothing about best scores).

```json
"stats": {
  "punkte": { "label": "Punkte", "better": "higher" },
  "bestzeit": { "label": "Bestzeit", "better": "lower", "format": "time" }
}
```

**The SDK gets `connectSolo`.** A separate entry point for games with `mode: "single"` and `server: false`:

```ts
import { connectSolo } from "@gamehearth/sdk/client";

const game = await connectSolo<Save>();
game.saved;                         // Save | undefined, loaded at start
game.best.punkte;                   // own best score or undefined
await game.save(state);             // on the device right away, on the server later
await game.record("punkte", 1200);  // the platform keeps the better value
```

Whether higher or lower is better is stated only in the manifest; an agent cannot swap the direction in code. Internally this becomes the profile operation `max` or `min`. Rejected: the profile operations themselves (`profile.max`, `profile.min`) in the client (the direction would be stated twice, and a swapped `min` would only show up at runtime).

**Played without a room, only with an account.** For single-player games without a reducer the game list shows "Play" ("Spielen") instead of "Create room" ("Raum erstellen"). That opens a separate game page with the iframe and its own bridge, without a room, without WebSocket, the same online and offline. "My rooms" ("Meine Räume") stays for matches with others. Only accounts may play, in line with "guests may only join"; save and best scores always belong to an account. Rejected: a room with one seat (impossible offline, so a second path anyway, and "My rooms" would fill up with single-player matches) and guests as single players (throwaway saves, takeover via the invite link, more cases in UI and tests).

**Offline via the preloaded HTTP cache.** A probe on 2026-11-18 (Playwright with Chromium and WebKit on Windows) showed: the platform's service worker does not see the requests of a sandboxed iframe, not even the iframe's navigation. Offline, however, the game files come from the browser's normal HTTP cache, because the server delivers them as `immutable`, even after a browser restart. Preloading from the platform's window fills this cache only in Chromium; WebKit partitions it by the origin of the frame. Loaded from a hidden sandboxed iframe, the files end up, in both engines, where the game later finds them. It follows:

- When the app is online, it preloads the current build of all installed single-player games via a hidden sandboxed iframe, once per build. Sandbox and CSP of the games stay unchanged.
- The app keeps the game list, your own best scores and the leaderboards, the saves and the logged-in account on the device. Offline, the home page shows the single-player games.
- Before an offline start the app checks whether all files are in the cache and says honestly when the browser has cleared them in the meantime.

Firefox could not be started on the probe's machine (Windows refuses the program); whether it serves sandboxed iframes from the HTTP cache is unchecked. The same goes for real Safari on the iPhone, which is checked by hand. Rejected: preloading per game at the push of a button (a step you have to think of before the train ride), offline only for games already played (a new or updated game would only work after an online start), the iframe without a `sandbox` attribute so that the service worker serves the navigation (isolation would depend only on the CSP of the response, and the game's files would still bypass the service worker) and files via `postMessage` as `blob:` URLs into the iframe (Phaser's loader and the modules would have to be bent around it).

**The platform shows the leaderboard.** Via the SDK the game gets only the player's own best scores, for example for "Record" ("Rekord") in the game. The game page shows your own best scores and a leaderboard of the accounts on this server (top 10 per stat), offline with the last known state. Names of other people never reach the iframe. All values come from the client and can be faked; within your own circle that does not matter. Rejected: only your own best scores (no comparison within the family) and the leaderboard including names in the game (third-party game code would see all names, every game would rebuild the display).

**Deleting.** In the menu of the game page you delete your own save or your own best scores, each after confirmation and on all devices. This is also the emergency exit when a broken save crashes the game while it loads. In the admin view an admin deletes individual entries of a leaderboard (test values, cheating). Deleted accounts take their saves and best scores with them. Rejected: only the player (altered values would stay unless that person acted) and only the save (test values would stay in the family list for good).

**Package, server and `check`.** A game without a reducer has no `game.mjs`; the hash of the build covers manifest and client. The server installs it without a sandbox and trial match, the catalog lists it with `mode: "single"`. `check` checks without a browser: the manifest including `stats`, licenses, the client folder and, in the built client, calls that fail in the sandbox (`localStorage`, `indexedDB`, `document.cookie`, external requests). A game's own tests secure its rules; the template shows them as pure functions without Phaser. Rejected: a smoke test in the browser via Playwright (every game repo and every CI would download Chromium, `check` would become slow and more fragile for outsiders).

**`dev` for single player.** A frame sized from `screen` of the role `player`, next to it, expandable, save and best scores as JSON with "Delete save" and "Delete best scores". `dev` writes both to `.gamehearth/dev-save.json` in the game folder (in `.gitignore`): it survives a restart of `dev`, and you can jump straight to a point (for example level 9) by editing the file. When the client changes, the frame reloads and reads the save again. Rejected: only in memory (to check level 9 you would have to play your way there every time).

**The template `single` has its own example: "Mushroom Hunt".** A character runs with a d-pad or arrow keys through 3 small maze levels and collects all mushrooms (arcade physics with walls). The save holds the unlocked levels and the current one, the best score is the fastest total time (lower is better). The levels are text grids in the code. Mauerbrecher is created from it with `new --template single` and so tests the path "replace the example completely". Rejected: a star catcher (the controls would resemble Mauerbrecher's paddle, and there would hardly be a save).

**Two steps.** Step 9 is the platform: `connectSolo` in the SDK, saves and best scores in the server including sync and leaderboard, packages, installation and catalog without a reducer, `check` and `pack`, the game page, offline preloading and the leaderboard in the UI, tested with a small test game in `fixtures/`. Step 9b brings the template `single`, `dev` for single player and Mauerbrecher in its own repo, built by an agent with no prior knowledge. Each step gets its own review. Rejected: one step (review too big) and three steps (sync would at first only be built against tests).

**Acceptance run.** An agent with no prior knowledge builds Mauerbrecher from `new --template single` following a request the way a non-programmer would type it; whatever snags goes into the template and `AGENTS.md`. It is accepted when `npm test`, the type check and the browser tests in the monorepo are green, a match including save, best score and offline start runs through on the platform via Playwright, and Mauerbrecher passes `check` and `pack` in its own repo. Repo, release and catalog entry only come after a separate OK.

**Already settled while deciding:** uploads are batched, not sent on every save. On logout the app first syncs and then deletes this account's data on the device. If a session ends while something is still waiting to be uploaded, it stays on the device until the same account logs in there again. `mode: "single"` with a reducer stays as it is (a room with one seat) and is not part of step 9.

**Not in step 9 and 9b:** profiles with items and flags, `ids.lock`, leaderboards from reducer games, guests as single players, a smoke test in the browser in `check`, sound.

**Settled while building step 9** (details in [packages/sdk/README.md](../packages/sdk/README.md#single-player-without-a-reducer-connectsolo), [packages/server/README.md](../packages/server/README.md#single-player), [packages/client/README.md](../packages/client/README.md#single-player-and-offline) and [packages/devtool/README.md](../packages/devtool/README.md#single-player-without-a-reducer)):

- The SDK is now 0.1.2. Single-player games without a reducer require at least `"sdk": "^0.1.2"` in the manifest, have only the role `player` and at most 10 best scores. So far only they have best scores.
- `game.saved` returns a separate copy on every read, so that a game may modify the loaded save without it counting as saved. On errors `save` and `record` reject instead of silently dropping the value; `null` stands for "no save" and cannot be saved.
- The bridge has its own messages for this (`solo-ready`, `save`, `record`, `solo`). If a game calls `connect` or `connectSolo` on the wrong page, the platform answers with `refused` and an explanation instead of letting the game wait 10 seconds.
- `check` searches the game's source code, not the built client: Phaser brings its own `localStorage` calls, which are intercepted in the iframe. Errors are `connect` instead of `connectSolo` and `game.record` with a name that is not in the manifest; sandbox traps are warnings.
- Deleted saves remain on the server as a marker with a timestamp. Otherwise a device that was offline during the deletion would bring the old save back at the next sync. Best scores can only be deleted with a connection; the save also offline, and the deletion then goes out with the next sync. (For best scores, since the review, with a deletion counter instead of a timestamp, see below.)
- The server skips best scores with names the manifest does not (or no longer) know and lists them, instead of rejecting the whole sync; otherwise a device with an old state would stay stuck for good. The leaderboard shows no guests and no locked accounts. Syncs are limited to 60 per minute and account and to 96 KB per request.
- Preloading goes through `/preload/<n>`, a page with a sandbox CSP whose only script is allowed by hash and only fetches files under `/games/`. It stays valid for one year, so that offline it comes from the cache itself. Besides all files, the folder address under which the platform opens the game (`…/` instead of `…/index.html`) is preloaded too; for the browser cache these are two entries. The browser test in WebKit found this, where the game had never run online before.
- In WebKit the HTTP cache serves offline only a browser with a persistent profile, not Playwright's ephemeral context and probably not private browsing. The browser test for WebKit therefore runs with its own profile. The check before an offline start takes at most 15 seconds; if a game does not respond for 12 seconds, the game page says so.
- On logout, whatever could not be synced within 3 seconds stays on the device until the same account logs in again. This refines "syncs and then deletes": a save is not lost just because the server is not answering at the moment.
- In the monorepo the test game "Sammler" (collector; `fixtures/sammler`, no engine, best scores with `higher` and `lower` including the time format) tests server, UI and browser tests; like Mau-Mau it only changes when tests need it.

Tightened after review 9 (2026-11-18, reviewer with no prior knowledge of the code and docs of step 9; regression tests in `packages/server/test/solo.test.ts`, `packages/client/test/solo.test.ts`, `packages/sdk/test/solo.test.ts`, `packages/devtool/test/check-solo.test.ts`, `manifest.test.ts`, `e2e/solo.e2e.ts` and `e2e/solo-webkit.e2e.ts`):

- Files like `sheet@2x.png` were preloaded as `sheet%402x.png`; but the game requests `sheet@2x.png`, and offline the file was missing although the check reported "ready" ("bereit"). The addresses are now built with the browser's URL parser. The test game Sammler loads an image with `@` in its name for this.
- Instead of a deletion timestamp, best scores have a **deletion counter per stat**. With every value a device sends the counter it knew when the value was reached; the server skips values from before the deletion and clears them from the device. Before, an old value reached offline brought back a higher value after the deletion, an old value already synced stayed on other devices and made new best scores bounce off as "not better", and a wrong clock swallowed new values or made deleting ineffective. For the save the device's clock remains decisive (decided that way).
- A deleted save that the server had never seen got no marker and stayed pending on the device forever. The server now creates a marker in that case too.
- On logout the account stayed playable offline if something was pending: on a shared device someone other than this account would have played. Logout now always forgets the account; only pending data stays until the next login of the same account. A sync that was still running at logout writes nothing to the device afterwards.
- Two tabs or windows overwrote each other, because each wrote back its own state. The device storage now reads afresh before every read and change.
- If a newer save from another device only arrived after the start (sync longer than 4 seconds), the game kept running with the old save and overwrote the newer one at the next save. The game page now reloads the game with the new save and says so. If the game list hangs for more than 4 seconds, it takes the offline path including the check instead of loading endlessly.
- `game.record` reported success although full storage could not take the value; now it fails loudly like `game.save`.
- If an update turns a game with a reducer into one without, the server closes its lobbies; running matches play to the end, there is no new round.
- `check` reported every `.record("…")` with an unknown name as an error, also on the game's own objects (`history.record("move")`). Now only on the result of `connectSolo` and variables of type `SoloGame`; if the game object cannot be recognized, there is only a warning.
- A stat named `constructor` returned the built-in function instead of "no value" in the game and in the leaderboard. The manifest rejects such names, and best scores come without inherited keys. An admin who deletes the best score of an unknown account gets 404 instead of an internal error.

**Settled while building step 9b** (details in [packages/devtool/README.md](../packages/devtool/README.md#new)):

- The dev tool is now 0.4.0. `new --template single` creates a game from the template "single"; the default stays `turn-based`.
- Mushroom Hunt puts its rules into `src/` without Phaser: levels as text grids with a check that every mushroom can be reached from the start, and the save with a format number, unlocked levels and the run in progress. Only a run from level 1 counts for the best time; levels played for practice do not count. It saves at the start of a run and after each level, not in the middle of a level.
- The menu is HTML above the playing field, not Phaser: real buttons, usable with the keyboard and easy for agents to test with Playwright. The play time counts frames at most 100 ms each, so that switching to another tab does not inflate it. While steering, the character is pulled to the middle of the corridor so that it fits around corners.
- The template draws the field at the device's resolution (`devicePixelRatio`, at most three times) and zooms the camera, so that it stays sharp on phones; the page's grid column does not grow with the canvas (`minmax(0, 1fr)`), otherwise the field would extend beyond the platform's frame.
- `dev` shows single-player games in a frame sized from `roles.player.screen`, without match, seats, bots and ticks. Save and best scores live in `.gamehearth/dev-save.json` and are shown below the frame with "Reload", "Delete save" and "Delete best scores"; a rejected best score or save appears as an error on the page and in the terminal. If `mode` or `server` change, `dev` asks for a restart instead of switching the kind of game while running.

From the acceptance run (2026-11-18: an agent with no prior knowledge built Mauerbrecher from `new --template single`; tests, type check, `check` and `pack` green, looked at the UI itself via Playwright; afterwards a whole match on a fresh platform via Playwright: installation from a local catalog, save on the server, continuing with identical level, points and lives, best score in the leaderboard, offline start and sync afterwards):

- The agent computes ball, paddle and bricks itself in `src/` and lets Phaser only draw; this way "continue exactly where you left off" can be saved exactly and tested without a browser. `AGENTS.md` now names this path next to the arcade physics.
- `AGENTS.md` now says where assumptions go when the person cannot be reached ("Decided by the agent, please check" in the README), that `client/src/view.ts` must work without a browser, what `.gamehearth/dev-save.json` looks like, that saving on close does not always arrive, when points are reported, and that the console message about `webrtc` is harmless. The search for leftovers now lists only names that one's own game hardly needs. The structure of one's own game belongs in its README.
- The SDK README did not limit the ban on `Math.random()` and `Date.now()` to rules on the server; that contradicted `AGENTS.md`. References to other packages of the monorepo, which led nowhere in `node_modules`, have been replaced.
- On the platform Mauerbrecher's field extended beyond the frame: the page's grid column grew with the double-size canvas. Fixed in the game and the template; the browser test of `dev` checks that nothing sticks out.

Tightened after review 9b (2026-11-18, reviewer with no prior knowledge of template, `dev`, Mauerbrecher and docs; regression tests in `packages/client/test/solo.test.ts`, `packages/devtool/test/dev-solo.test.ts`, the tests of the template and of Mauerbrecher, plus a Playwright run against `dev` of Mauerbrecher):

- A game that always saves when hidden gave an unchanged old save a new timestamp; a device on which nobody had played thus pushed out a newer save from another device, and a save in a newer format was overwritten without any input. The platform now accepts an unchanged save without a new timestamp, the template and Mauerbrecher save only what changed, and `AGENTS.md` makes this a rule.
- When continuing, Mauerbrecher did not keep balls, paddle and active power-ups, as the decision requires; a ball below the paddle was rescued after pausing and reloading. The save now holds the whole motion. If a stored save no longer fits its level after a change, only that level starts over, instead of discarding the whole run.
- If saving failed at the end of a game, Mauerbrecher got stuck, and the points never reached the leaderboard. Game and template now report the best score first, catch errors, print them and carry on; `AGENTS.md` says so.
- The template did not count aborted attempts toward the best time: reloading in the middle of a level reset its clock. It now saves the level time every 2 seconds and when hidden. W, A, S, D also work in upper case, and a frame counts up to 250 ms, as much as Phaser itself catches up.
- `dev` passed invalid best scores from `dev-save.json` through to the game, which then waited 10 seconds for the platform; it now takes only names from the manifest and reports the rest. `dev` overwrote a broken file, best scores included, at the next save; now it refuses to write until the file is repaired, and also reports file problems in the terminal. A rejected best score disappeared from the page with the next successful save; save and best scores now have separate messages.
- Mauerbrecher's README no longer links to the private platform repo and describes its own structure.

### Options and profiles from step 10

Decided on 2026-11-18 in a grilling session before step 10. Refines "Game data, options and profiles" and changes four points there: the catalog of IDs lives in the manifest instead of the code, a reducer writes best scores with `record` instead of `max` and `min`, `ctx.options` exists in all phases and in the client, and free single-player games do not get items, counters and flags yet.

**The whole block, in three parts.** Options, `random.weighted`, profiles with items, stats and flags, the catalog of IDs, `ids.lock` and leaderboards from reducer games all come, cut into three steps with a review of their own each:

- **10:** options and `random.weighted` all the way through: SDK, manifest, `check`, server, lobby, `dev`, templates, Mau-Mau and Farbfelder.
- **10b:** the profile platform: catalog in the manifest, `ids.lock`, SDK, server with atomic operations and recomputing, game page with profile and leaderboards, admin view; tested with a test game in `fixtures/`.
- **10c:** profiles in the templates and in `dev`, the stat `siege` (wins) in Mau-Mau and Farbfelder, game 4 "Angelteich" (fishing pond) by an agent with no prior knowledge.

This way options are usable right after step 10. The decisions got a day of their own; building starts on 2026-11-19. Rejected: only options and stats now, items and consumption only with a game that needs them (the hardest part of the contract would stay unbuilt and untested), two parts as in steps 8 and 9 (review 10 would be very large) and four parts (profiles would be built only against tests for a long time).

**Game 4 is "Angelteich".** For 1 to 4 players, turn-based, each on their own device. Players take turns casting the line and use up bait from their profile; the catch comes from a weighted table ranging from common to legendary. Fish are sold for coins, the shop has bait and better rods, and a collection book records via flags which species you have already caught. The best score is the biggest fish, the number of rounds is an option. Every part of the contract shows up in it in a natural case, and it suits the family. An agent with no prior knowledge builds it from `new --template turn-based`; repo, release and catalog entry only come after a separate OK. Mau-Mau and Farbfelder get options and the stat `siege` (wins), Mauerbrecher stays as it is. Rejected: only a test game and the template (whether agents use the contract correctly without help would stay untested), items in Mau-Mau (contrived, and the frozen test copy would have to follow), a cave co-op (more rules, harder for an agent to build cleanly) and a collectible card duel (hidden information and balancing work).

**Options in the manifest: choice and yes/no.**

```json
"options": {
  "stapeln": { "label": "7er stapeln", "type": "boolean", "default": true },
  "spielzeit": {
    "label": "Spielzeit",
    "type": "choice",
    "default": 90,
    "choices": [
      { "value": 60, "label": "1 Minute" },
      { "value": 90, "label": "1,5 Minuten" },
      { "value": 120, "label": "2 Minuten" }
    ]
  }
}
```

A choice has values that are texts or whole numbers, each with a display name; numbers like the play time are given as a list. So there are finitely many values, `check` plays each one once, and the lobby shows dropdowns and toggles without game code. Options do not change the allowed player counts. Rejected: number ranges with `min`, `max` and step (`check` would only test the edges and the default, and the lobby would need a number field with validation).

**`ctx.options` in all phases and in the client.** The game reads the options in `setup`, `apply`, `legalMoves` and `tick`; for this, `legalMoves` already gets `ctx` as an optional third parameter in step 10, which the profiles need anyway. The match stores the options (`match.options`), and the client gets them with every update (`update.options`). Rules like "stack sevens" ("7er stapeln") take effect in `legalMoves` and `apply`, and the UI has to show them; otherwise a game would have to copy them into the state, and a forgotten field would only show up at runtime as `undefined`. Rejected: `ctx.options` only in `setup` (as the design said so far).

**Lobby.** Only the host sets the options; all members and paired TVs see the choice. It stays in the room across new rounds. If a lobby moves to a new build, unknown options and values fall back to the default. Single-player games without a reducer have no options; they build their menu themselves as before.

**`check`, `dev` and games with options.** `check` plays every value of every option at least once per player count, with the other options at their defaults; the seeds stay fixed. `dev` shows the options above the seats; a change starts a new match. Card Duel gets the option `rounds` (3, 5, 7), Tag the play time (`duration`). Mau-Mau gets "jack on jack" ("Bube auf Bube", default no), "stack sevens" (default yes, as today) and the ace rule ("go again" / "noch mal dran" as today, or "next player is skipped" / "Nächster setzt aus"), Farbfelder the play time (60, 90 or 120 seconds, default 90) and the field size (small, medium as today, or large). `fixtures/mau-mau` stays frozen; the platform tests get a test game of their own. The SDK is then 0.1.3; games with options require `"sdk": "^0.1.3"` so that older servers do not install them.

**`random.weighted` draws from a table with integer weights.**

```ts
const fang = ctx.random.weighted([
  { id: "barsch", weight: 60 },
  { id: "hecht", weight: 25 },
  { id: "goldfisch", weight: 1 },
]);
```

Entries are objects with an integer `weight` of 0 or more, at least one of them greater than 0; it returns the drawn entry itself, i.e. directly a row of the data table. With whole numbers, Node and QuickJS draw exactly the same, and probabilities can be read as "1 in 86".

**The catalog lives in the manifest.**

```json
"stats": {
  "siege": { "label": "Siege", "better": "higher" },
  "fische": { "label": "Gefangene Fische" }
},
"items": {
  "koeder-wurm": { "label": "Wurm" },
  "rute-alt": { "label": "Alte Rute", "deprecated": true }
},
"flags": {
  "buch-hecht": { "label": "Hecht im Sammelbuch" }
}
```

Items, stats and flags are in the manifest, each entry with a display name and optionally `deprecated`. Server, `check` and catalogs read them without game code, the same way for games with and without a reducer, and the game page can name them. For stats, `better` and `format` from step 9 stay, but `better` becomes optional: without it, a stat is a counter without a leaderboard. Data tables in the code take their ID types from the imported manifest (`keyof typeof manifest.items`); a typo, even in a rare drop, thus becomes a type error. The limits from "Game data, options and profiles" also apply to the catalog; single-player games without a reducer keep at most 10 best scores. Rejected: items and flags exported in the code and written into the package as a file by `pack`, as in the design so far (two places for IDs, and games without a reducer would need a separate place for their catalog).

**`record` instead of `max` and `min`.**

```ts
apply(state, action, ctx) {
  ctx.profile.use(ctx.player, "koeder-wurm", 1);
  ctx.profile.add(ctx.player, "muenze", 5);
  ctx.profile.stat(ctx.player, "fische", 1);
  ctx.profile.record(ctx.player, "groesster-fisch", 83);
  ctx.profile.flag(ctx.player, "buch-hecht", true);
}
```

`record(seat, name, value)` takes the direction from `better` in the manifest and only works on stats with `better`; counters go through `stat(seat, name, n)`. Single-player games and reducers thus share the same vocabulary, and the direction lives only in the manifest. `flag` with `false` deletes a flag. Writing happens only in `apply` and `tick`, not in `setup`; `use` exists only in `apply`, because a tick cannot be rejected without halting the match. If an item that a move consumes is missing, the server rejects the move with an error code of its own; an ID outside the catalog is an error in the game code and appears as an incident. Rejected: `max` and `min` as in the design so far (two vocabularies, the direction in two places).

**Server.** As in the design, the server commits the move and the profile changes together, and the game sees the current profile on every call. The history stores the profiles that were read only if they changed since the last entry. If another match changes a profile, the server recomputes the legal moves of the running turn-based matches of this game with this account and records this as `refresh` in the history. A realtime tick with profile changes writes the snapshot of the match in the same transaction, so that nothing counts twice after a crash. Guests get an empty throwaway profile per match, as decided.

**The player's own profile comes with every update.** The client gets the player's current own profile (`update.profile` with items, stats and flags), also after changes from other matches; never the profiles of the other players. What other players see is still determined by the state. A display of coins or inventory thus needs no copying into the state and does not lag behind. Rejected: only via the state (after a change from another match the display would show old values although the legal moves are already new).

**Single-player games without a reducer stay with `save` and `record`.** Items, counters and flags via `connectSolo` are deferred: an item consumed offline can be missing at sync time, everything can still be faked by the client, and the save document already holds inventory and unlocks today. Their best scores from step 9 are profile stats in the same table with the source "device"; their leaderboard says "reported by device" ("vom Gerät gemeldet"). Rejected: only gains via `connectSolo` (more sync code, useful mainly for statistics) and all operations as in the reducer (the most edge cases).

**One game page per game.** Every game gets a page, reachable from the game list: description, "Create room" ("Raum erstellen") or "Play" ("Spielen"), the player's own profile with the display names from the manifest and the top 10 per ranked stat, offline with the last known data. Single-player and multiplayer pages share the building blocks. The player's own profile for a game can be reset there after a confirmation; an admin resets or deletes profiles in the admin view. Rejected: the leaderboard only in the lobby and at the end of a round (you would only see it in a room) and one central page for all leaderboards (separate from the game).

**`check` writes `ids.lock`.** `check` adds new IDs from the manifest to `ids.lock` by itself, like npm does with its `package-lock.json`, and reports IDs that are listed there but missing from the manifest as errors; outdated ones stay in the manifest marked `deprecated`. In CI (`CI` set) `check` writes nothing and fails if the file is out of date. An ID that was never published is removed from the file by hand; `AGENTS.md` says when that is allowed. If an update no longer knows IDs that are in profiles on this server, the admin view names them but installs anyway, so that rolling back to an older version stays possible; the values stay in the profile, and the server rejects operations on them. Rejected: entries by hand only (agents would add them without thinking anyway) and a version per entry stamped by `pack` (`pack` would have to run locally before the tag and the result would have to be committed).

**Templates, `dev` and the other games (10c).** Card Duel gets the ranked stat `wins` and the item `joker`: whoever wins gets one; if you play it together with a card, that card counts double and the joker is used up. This shows `add`, `use`, `stat`, `ctx.profiles` in `legalMoves` and `ids.lock` in a small case, because agents pick up patterns from code more readily than from docs. Tag gets wins, the template `single` stays as it is. In `dev`, every seat has a collapsible, editable profile, stored in `.gamehearth/dev-profiles.json`, and can be switched to "Guest". Mau-Mau and Farbfelder get the ranked stat `siege` (wins). After step 10b the SDK is 0.1.4. Rejected: only an option and a stat in the template (items would only be in the docs) and unchanged templates.

**Reset and delete in the admin view** (decided on 2026-11-20 before building step 10b): Reset empties an account's profile for one game completely, i.e. items, stats and flags. Delete removes single entries, an item, a stat or a flag, just as an admin has been deleting single best scores from the leaderboard since step 9. This way test values and cheating can be removed in a targeted way without losing the rest of the profile. Rejected: delete as "all profiles of the account across all games" (deleting the account covers that) and only one button (single wrong values could only be removed together with the whole profile).

**If a guest becomes an account in the middle of a match** (decided on 2026-11-20 after review 10b), via an invite or because an account takes over their seats, their seat keeps the throwaway profile, with everything they collected in it, until the end of this match. From the next round on, the account profile applies. That way nothing changes in the middle of a match, and the account profile gets nothing from a match that began as a guest. Rejected: the account profile right away (the guest would lose what they had collected in the middle of the match, and the moves would change without anything they did).

**Not in steps 10 to 10c:** items, counters and flags for single-player games without a reducer, options for single-player games without a reducer, number ranges as options, leaderboards split by options (a game can create its own stats for that), profiles of other players in the client, profile migrations by the game (rejected, as decided).

**Built in step 10 (2026-11-20).** What was settled while building, without changing the decisions above:

- **Names and limits.** Option names start with a lowercase letter and consist of letters and digits (`bubeAufBube`), so that `ctx.options.name` works; at most 12 options, a choice has 2 to 20 values of the same type (texts up to 40 characters or whole numbers), display names up to 40 characters. Validation, filling in defaults (`resolveOptions`) and display live in the SDK, so that dev tool, server and UI use the same rules.
- **`ctx` in `legalMoves`.** For the game, the third parameter is always there and typed; `defineGame` returns a game whose `legalMoves` tests may still call with two arguments, as long as the game does not need `ctx`. The game gives the type of the options as the third type parameter (`defineGame<State, Action, Options>`), also as an `interface`. `result` still gets no `ctx`.
- **Match and sandbox.** `match.options` exists only in matches with options; every phase gets a frozen copy. The sandbox takes the options from the values the host expects, never from the output of the game code, like seed and seats.
- **Server.** Migration v9 adds `rooms.options` (the server backs up the database before the migration). `set-option` sets an option (host only, lobby only, error `invalid-option`); the room shows `options` with description and values, during the match those of the match. Only explicitly chosen values are stored; everything else is at the default of the respective build. When moving to a new build (lobby after an update, new round, abort, server start with changed games from `GAMES_DIR`), the server keeps only chosen values that the new build knows, so that a value that becomes known again later does not come back. The trial match at install time plays with the default values.
- **`check` and `dev`.** `check` distributes the matches of each player count in turn over the variants (default, then every other value of an option once) and plays at least one match per variant; `--option name=value` fixes a choice. `dev` shows dropdowns in the header bar; a different choice or changed options in the manifest start a new match.
- **Test game and templates.** `fixtures/gluecksrad` (1–4 players, rounds and joker, drawing with `random.weighted`) tests the path in server, UI and browser tests. Card Duel shows the number of rounds via `update.options`, Tag converts the play time into ticks in `setup`.
- **Mau-Mau and Farbfelder 0.2.0.** Mau-Mau: `bubeAufBube`, `siebenerStapeln`, `ass` (`nochmal` or `aussetzen`); the table names a house rule that differs from the default where it applies ("+2 · don't stack", "+2 · nicht stapeln"). Farbfelder: `spielzeit` (60, 90, 120) and `feld` (small 24 × 14, medium 32 × 18, large 40 × 22); the field size is in the state, so that TVs and rules know it.

Tightened after review 10 (2026-11-20, reviewer with no prior knowledge of platform, dev tool, templates and docs; regression tests in `packages/server/test/options.test.ts` and `packages/devtool/test/check-options.test.ts`, each with a counter-check):

- The trial match at install time from a package or catalog ran without options. `ctx.options` was empty: Tag returned `NaN` as the remaining time, Card Duel never ended, so games from the new templates could not be installed although `check` was green. The trial now plays with the default values, in all moves and ticks.
- `check` reported a variant in which matches never end only as a warning, because the share of endless matches was counted across all variants of a player count. It now counts per variant.
- In QuickJS only the first matches were replayed; variants beyond those stayed unchecked there. Now at least one runs per variant.
- The server stored the whole resolved choice, so a new default value did not reach rooms in which any option had been changed. Now it stores only chosen values.
- After a restart with changed games from `GAMES_DIR`, the lobby showed the options of the old build, while the start used the new one. Lobbies of local games move over when the server starts.
- The server README names `invalid-option` and the default values of the trial match; a test covers a start while the host is changing a setting (`stale`).
- Open: the warning "setup returns the same start for every seed" needs 3 matches per variant. For realtime with more than 6 variants (20 matches) it no longer triggers.

**Built in step 10b (2026-11-20).** What was settled while building, without changing the decisions above (details in [packages/sdk/README.md](../packages/sdk/README.md#profiles), [packages/devtool/README.md](../packages/devtool/README.md#idslock), [packages/server/README.md](../packages/server/README.md#profiles) and [packages/client/README.md](../packages/client/README.md#game-page-and-profiles)):

- **SDK 0.1.4.** In `apply` and `tick`, `ctx.profiles` shows writes of the same call immediately; in `setup` and `legalMoves` it is a frozen snapshot, and calling `ctx.profile` there is an error in the game code with an explanation. `stat` works on every stat, ranked ones included (wins are counted with `stat`), `record` only on stats with `better`. The game gives the type of the IDs as the fourth type parameter, `defineGame<State, Action, Options, CatalogOf<typeof manifest>>`; `CatalogOf` provides `items`, `stats`, `flags` and `ranked`, so that `record` with a counter is already a type error. The runner rejects a missing item in `use` as `missing-item`, even if the game catches the error; in realtime only this input is dropped. A wrong ID, a wrong value or a foreign seat is an error in the game code with the location in the source and a suggestion for typos, likewise even if the game catches it. At most 1,000 profile changes per call; flag texts have 1 to 200 characters, `false` deletes. `refreshMatch` recomputes the moves with new profiles and increments the version.
- **Manifest and dev tool 0.6.0.** Validation of the catalog lives in the SDK, like that of the options. Single-player games without a reducer have only `stats`, each with `better`, at most 10; `check` rejects `items` and `flags` for them. Games with a reducer and a catalog require `"sdk": "^0.1.4"`.
- **`ids.lock`** is JSON with `format`, a note for humans and agents, and the sorted IDs per section. CI counts as `CI` being set, except to `false` and `0`. Games without IDs need no file; it does not go into the package.
- **`check` with profiles.** Each seat starts empty half of the time (like new players and guests, which are the same thing within a match) and filled randomly from the catalog the other half. Before each move, `check` takes items away with 5% probability and has the moves recomputed with `refreshMatch`, as the server does after a parallel match. If `legalMoves` then offers a move that `use` rejects, that is an error: the player would never get anywhere with this move. Profile changes count toward the fingerprint of each step; the replay and QuickJS replay with the same profiles and removals. A move that only changes a profile no longer counts as "changes nothing".
- **`dev` in 10b** keeps profiles per seat in memory only, empty for every new match and included when replaying, so that games with profiles already run there. Editing, the guest toggle and `.gamehearth/dev-profiles.json` are left for 10c.
- **Sandbox.** The guest runner gets the catalog when a build is loaded, not with every call; the profiles come with every call. The host's output check accepts profile changes only in a known shape, with seats of the match and in a limited number.
- **Server.** Migration v10 adds `profiles` (items and flags as JSON per account and game, with `revision`), plus `rooms.guest_profiles` and the entry type `start` in the history; stats stay in `stats`, from games with a reducer with the source `server`. Before every call of game code, the server reads the profiles including `revision`; in the write transaction it checks `revision` and the seat assignment and, if something changed, recomputes the move with the new profiles (at most five times) instead of reporting `stale`. It applies every change once more itself with the rules of the SDK; if that fails, it is an incident. Games without a catalog get empty profiles without the server reading anything.
- **Recomputing** runs one after another per room. If the moves change, the version goes up, the history gets `refresh` with the profiles, and "Your turn" ("Du bist dran") goes out as after a move. If the moves do not change, the room only gets a new update with the new profile, without a new version. Realtime needs no recomputing; a step with profile changes writes changes and snapshot in one transaction, recomputes up to three times if a profile it read has changed, and then sends the whole room instead of a frame.
- **Guests** have their throwaway profile per seat in `rooms.guest_profiles`; so do seats whose account was deleted. New round and abort clear it.
- **History.** Profiles that were read appear in the entry only if they changed since the last stored entry of the round, at the start compared with all-empty profiles; so if a move changes the player's own profile, it appears with the next move. The start writes an entry `start` with version 0 if a profile is not empty.
- **Game page** at `/game/<id>`, reachable via the name in the game list. The profile is shown by section in the order of the manifest, deprecated entries with "(deprecated)" ("(veraltet)"); IDs that the build no longer knows are visible only in the admin view. For games with a reducer the leaderboards show only values from the server, for single-player games only from the device, with "reported by device". Guests see the leaderboards but no profile. Reset empties items and flags and sets stats to empty with an incremented deletion counter, so that devices of single-player games do not bring back old best scores. Offline the page shows the last known data per account; "Playable offline" ("Offline spielbar") links saved pages of games with a reducer, logging out deletes them.
- **Admin view.** Per game, the profiles of accounts that have content, "Delete" ("Löschen") per entry and "Reset whole profile" ("Ganzes Profil zurücksetzen"), each after a confirmation. Unknown IDs are named in the game row, the profile list and the message after an install.
- **Test games.** `fixtures/dorfladen` (1–4 players, coins and apples as items, wins, best score, counter and a time as stats, one flag with `true` and one with text, a deprecated item, ID types from the imported manifest) tests the path in `check`, server, UI and browser tests. For realtime with profiles, the server tests have the small game `sammeltakt`.
- Open: pending recomputing is held only in memory; after a restart, only the next move computes with the current profile, and a move with an item that has gone missing in the meantime then fails with `missing-item`.

Tightened after review 10b (2026-11-20, reviewer with no prior knowledge of the code and docs of step 10b; regression tests in `packages/server/test/review10b.test.ts`, `packages/sdk/test/profile.test.ts`, `packages/devtool/test/check-profiles.test.ts`, `check-solo.test.ts`, `new.test.ts` and `packages/client/test/game-page.test.tsx`, each with a counter-check):

- Reset raised the deletion counter only for stats with a value. A device that had not yet synced a single-player best score brought it back afterwards, and so did a value after an earlier "delete best scores" ("Bestwerte löschen"). Now every stat of the manifest and every existing one gets a marker with a higher counter.
- The message for `missing-item` named seat and inventory, and the server passed it on to the client that made the move. A move that consumes items of another player would have revealed that player's inventory. The client now only gets "Something for this is now missing from the profile" ("Dafür fehlt inzwischen etwas im Profil"), also in realtime; the exact message stays with `check` and `dev`.
- In realtime, `check` missed an input that `legalMoves` offers and `use` always rejects. If an input fails with `missing-item` although no item was taken away in this tick and no earlier input of the same tick went through, that is now an error. The note on taking items away no longer says for realtime that `check` recomputes.
- The template `single` has had the stat `best-time` since step 9b, but no `ids.lock`; a new game made from it failed in its CI. The template now ships one, `new` copies it, and `AGENTS.md` says that the names of the example were never published and drop out of `ids.lock` when they are replaced. That is what the decision on `ids.lock` had intended. `fixtures/sammler` got one as well; the tests no longer depend on the environment variable `CI`. Mauerbrecher needs an `ids.lock` as soon as it moves to dev tool 0.6.0.
- If a guest became an account in the middle of a match, the account profile applied immediately. Decided and built: the seat keeps the throwaway profile until the end of the match (see above). At the start, the server remembers which seats have a throwaway profile.
- The runner still reported changes without effect (a `record` that is not better, a flag that is already set that way), and the server wrote them along with a new revision. In realtime, every tick with such a call would thus have become a transaction, with the whole room sent to everyone and recomputing in other rooms. Now they are dropped in the runner, and the server writes only real changes. The SDK docs advise against writing counters in every tick.
- For an unknown game ID, the admin view first created a profile row and then reported 404; now it checks the game first. The admin view deliberately does not show profiles of removed games, because it only lists installed games; they stay until the game is installed again or the account is deleted.
- If recomputing returns a match with a result (impossible with the SDK, but the host does not trust the sandbox), the server does not take it over and reports an incident.
- Reset has its own rate-limit bucket (10 per minute and account) instead of the one of the push settings. Logging out on the invite page clears the account's data on the device just like on the home page, including the saved game pages. The SDK docs also mention `profiles` and `profile` for `tick`.

**Built in step 10c (2026-11-20).** What was settled while building, without changing the decisions above (details in [packages/devtool/README.md](../packages/devtool/README.md#dev) and the `AGENTS.md` files of the templates):

- **Card Duel** gets the item `joker` and the ranked stat `wins`; whoever has the most points at the end gets both. `legalMoves` offers the joker variant of a move (`{ type: "play", card, joker: true }`) only with a joker in the profile; `apply` consumes it with `use`, and the card counts double when it is revealed. Until then the choice, joker included, sits in the player's own area. **Tag** gives everyone who was the catcher ("it") for the shortest time a win in the last tick. Both templates ship `ids.lock`, type the IDs with `CatalogOf<typeof manifest>` and ignore `.gamehearth/`. Phaser starts with `autoFocus: false` in all templates, because `window.focus()` is forbidden in the isolated frame anyway.
- **SDK.** `createMatch`, `applyMove` and `stepMatch` take the catalog as the loose type `CatalogInput`, so that tests can pass the imported `manifest.json` directly. Without a catalog, every ID is unknown. The version stays 0.1.4, because 0.1.4 is not published yet.
- **`dev`.** `.gamehearth/dev-profiles.json` has the shape `{ "seats": { "p1": … }, "guests": ["p2"] }`. Every new match starts with the stored profile; every change by moves, ticks and edits is in the file immediately. An edit validates like the server, rejects IDs that are not in the manifest, and recomputes the moves with `refreshMatch`; as on the platform, the version only goes up if the moves change. Edits are in the history with their position and are included when replaying; without a running match they apply to the next one. In realtime an edit takes effect from the next tick, and new rules start a new match as before, now with the stored profiles. "Guest" starts a new match in which the seat plays with an empty profile that `dev` does not store; which seats are guests is stored in the file.
- **Mau-Mau 0.3.0 and Farbfelder 0.3.0** give the winners the ranked stat `siege`, from the same function `winnersOf` as `result`: Mau-Mau in the `apply` that ends the match, Farbfelder in the last tick. Mauerbrecher stays at 0.1.0 and only gets SDK 0.1.4, dev tool 0.6.0 and an `ids.lock` with `punkte`. Mau-Mau and Farbfelder are published as 0.3.0 and listed in the Gamehearth catalog; Mauerbrecher is only pushed, without a new release.
- **Angelteich** (game 4) was built by an agent with no prior knowledge from `new --template turn-based`, from a description such as a person who doesn't program would give. It has the items coins, bait and three rods, the stats "Biggest fish (cm)" ("Größter Fisch (cm)", ranked), fish caught and wins, the flag "Starter pack collected" ("Startpaket abgeholt") and one collection-book flag per fish species with the record as text ("87 cm"). The catch is drawn with `random.weighted`, first the rarity depending on the rod, then the species. The agent decided further rules itself:
  - The longest fish chain wins, i.e. the most centimeters in total.
  - The starter pack is given once per account.
  - An emergency worm is given once per match, so that nobody gets stuck without bait.
  - Fish still in the bucket at the end are bought by the shop.

  The game is public in `hearthbit/gamehearth-angelteich`, release 0.1.0 is in the Gamehearth catalog; the release packages of all three games are byte-identical to the local builds. Installed on a fresh server via a local catalog and played by an account and a guest, the game page showed the profile, the collection-book texts and the leaderboard, and there was no second starter pack. What the agent reported about the instructions and the dev tool has been incorporated: `check` wrongly warned that `setup` returns the same start for every seed when `setup` only uses randomness with more players, because the decoy match with a different player count was counted too. On top of that came `autoFocus` and the docs on how the game page shows flags.
- Open: a command in `dev` for screenshots and clicks into a frame. The agent had no Playwright in the game folder and wrote its own driver over the DevTools protocol. Also missing is a pattern for prescribing specific randomness in tests, for example a particular catch.

Tightened after review 10c (2026-11-20, reviewer with no prior knowledge; regression tests in `packages/devtool/test/dev-profiles-review.test.ts` and `e2e/dev.e2e.ts`, each with a counter-check):

- **Lost profile values with a broken file.** If a match began with a broken `dev-profiles.json`, then after the repair the next move overwrote all profiles of the match with the empty start values. Likewise, the next write deleted an invalid seat and overwrote a file of the wrong shape without a message. Now `dev` never writes into a broken file (not JSON, unknown key, `seats` or `guests` of the wrong type, invalid seat). A match that began like that stores nothing even after the repair and says so; only the next new match reads and writes again.
- **Lost edits.** Edits without a running match and the values of a match whose new rules already fail while it is being set up were lost on the next reload, and the view then showed empty profiles. If replaying stopped, later edits also vanished from the file. Now the latest values count as the start of the next match, and later edits apply from the point where replaying stops; the note says so.
- The guest toggle read the player count before a newly chosen new match was in place, and undid it; it now runs in the same queue. Errors writing the file are shown on the page. The profile box says when the profile changed during writing (with "Discard"), and unchecks the guest box when `dev` rejects it.
- In Card Duel, after a rejected move ("stale"), "Joker on" stayed displayed, and the next tap played without the joker. The toggle now stays on until the move succeeds, and the scene redraws after every response (without a test of its own, since the scene only runs in the browser).
- Mau-Mau ignores `.gamehearth/` like the other games.
- A browser test of `dev` failed at random: since the Card Duel UI imports `cardValue` from `src/`, every rule change also rebuilds the UI. Vite briefly empties the folder while doing so, and `dev` reloaded the frames twice although the result was byte-identical; a move at that moment was lost. Now `dev` reloads the frames only when the content of the build, without source maps, changes, and a briefly empty folder leaves the frames as they are. If a frame loads exactly in this gap (for example because the match jumps back when replaying), the request waits for the build instead of failing with 404; without that, the frame stayed empty, because the second reload is now gone (regression test in `packages/devtool/test/dev.test.ts`, counter-check red before the fix; `e2e/dev.e2e.ts` green ten times in a row).
- When Angelteich was checked in, it turned out that `new` created the git repo with git's default branch, often `master`; but the CI of the templates only listens on `main`. `new` now sets the branch to `main`.
- Not adopted: the remark that a release does not check `ids.lock` is wrong; `pack` calls `check`, and `CI` is set in the release CI.

### Docs in English (step 13)

Decided on 2026-11-20 in a grilling session before step 13. Replaces the sentence in "Starter, `new` and `dev`" saying that all texts are German until the platform addresses a community. Step 13 comes before 11 and 12; those two are planned together afterwards.

**The line to step 12 runs between developers and players.** Everything that developers, agents and operators read becomes English: the Markdown docs of all repos (READMEs, this file, `AGENTS.md` and `CLAUDE.md`, the starter README, the READMEs of the test games, game repos, catalog), comments, test names in the monorepo and in the game repos, the output of `check`, `dev`, `new`, `pack` and `catalog add`, the host page of `dev`, all messages of the SDK and the dev tool, the server log, `admin.js` and the error messages of the API. What players see stays German until step 12: the UI (`texts.ts`), push notifications, the texts of the four games, names and labels in their manifests, the descriptions in the catalog and the frozen test games in `fixtures/`. Rejected: only the Markdown docs (agents would read English instructions and get German messages from `check` and `dev`) and everything including the UI (the family would play in English until step 12, and step 11 rebuilds the UI anyway).

**Messages from the SDK and the dev tool are English, also in the UI.** Install errors from the shared package validation, manifest errors, incident details and unknown IDs appear in English in the admin view until step 12. Players still see only texts from `texts.ts`: the UI shows its own texts for known error codes, and where a code that players can reach is missing there, it gets a German text. Rejected: keeping messages that can reach the UI German until step 12 (SDK and dev tool would be mixed, and for every message one would have to work out where it ends up).

**The templates become fully English.** They are named like the values of `mode`: `turn-based`, `realtime` and `single`; `new` still accepts the old names (`rundenbasiert`, `echtzeit`, `einzelspieler`). The examples are called "Card Duel", "Tag" and "Mushroom Hunt", with English IDs, labels and texts. Nobody plays them, but agents adopt their patterns; this way a new game is English throughout from the start, and step 12 can add German there as an example of a translation. The four games and the test games keep their IDs, because IDs are forever. Rejected: only identifiers in English (mixtures like `card-duel` with the name "Kartenduell") and leaving the templates German (English instructions next to German example code).

**Agents speak the person's language.** `AGENTS.md` says: the agent speaks the language the person writes in, and in that language it also writes the rules in the README and all texts in the game, unless the person wants it otherwise. Code, identifiers, comments and tests are English. Other people's game repos can thus be German or French; the four own games get an English README, because the maintainer wants it that way for the repos. Rejected: game texts and README always in English (the family would play English games until step 12, and a person without English could not check the rules of their own game) and prescribing nothing (German or English, depending on the agent).

**`design.md` is translated faithfully.** The structure, dates, rejected alternatives and the "Tightened after the review" sections stay, so that every section can be checked against the German version. New is a German–English glossary, which sessions use to translate the maintainer's German terms consistently. Where names change with step 13 (templates, examples, routes), the translation uses the new ones. Rejected: restructuring into a reference of the current state and a decision log (hard to cross-check while translating; stays a separate item, for instance when the platform becomes public) and tightening while translating (reasons would get lost).

**The German routes become English, without redirects.** `/konto` becomes `/account`, `/koppeln` becomes `/pair`, `/spiel/<id>` becomes `/game/<id>`, `/spielen/<id>` becomes `/play/<id>`. Push notifications link to `/r/<code>`, and the installed app starts at `/`; both stay. The app re-links saved game pages. Old bookmarks and the QR code of a TV that has been open since before the update lead to the home page; that is accepted. Rejected: the old paths as aliases (code for a few bookmarks) and changing the routes only with step 11 or 12 (the English docs would name German paths until then).

**From now on everything in the repos is English,** including commit messages, release texts and catalog commits, in the platform repo as well as in the game repos. The old history stays. Rejected: German commits (public repos with English docs and a German history) and English only in public repos (two standards).

**The public repos follow along without new releases.** SDK 0.1.5 and dev tool 0.7.0 (English output, new template names) go as tarballs into `vendor/` of the game and catalog repos, plus English docs and test names. Releases and catalog stay at Mau-Mau and Farbfelder 0.3.0, Mauerbrecher and Angelteich 0.1.0; the next real update of a game takes everything along. Farbfelder, Mauerbrecher and Angelteich get the current English `AGENTS.md` of their template, including the sentences that only concern their game, instead of a translation of their older copy; Mau-Mau stays without an `AGENTS.md`. The snapshot of the starter repo is rewritten. Pushing happens only after an OK. Rejected: patch releases of all games (four releases without a noticeable change, an update notice in every admin view) and keeping the old tarballs (`check` would keep printing German there, and the docs in `node_modules` would stay German).

**Deciding and implementing on the same day.** Rejected: letting the decisions rest for a day and implementing them the next day with fresh context.

**Built in step 13 (2026-11-20 and 2026-11-22).** The weekly usage limit split the build: up to dev tool 0.7.0 on the first day, e2e, game repos, catalog, starter and reviews on the second. What was settled while building, without changing the decisions above:

- **Versions.** SDK 0.1.5 and dev tool 0.7.0, not on npm. Workspaces that pin the SDK exactly moved to 0.1.5, and the server pins dev tool 0.7.0 (missed at first; `npm ci` in the Docker build then looked for 0.6.0 on npm and failed); the templates require `gamehearth` `^0.7.0`. Games and catalog have the new tarballs in `vendor/`, and their lock files carry the tarballs' new integrity values; otherwise `npm ci` fails in CI.
- **Templates and `new`.** The example IDs are new (Card Duel: `rounds`, `joker`, `wins`; Tag: `duration`, `wins`; Mushroom Hunt: `best-time`) and were never published, so the templates' `ids.lock` files were rewritten. The LICENSE placeholders are `{{year}}` and `{{holder}}`; without a git name the holder is "the authors of <name>". The CLI help now also lists `single`. `NewResult.git` is `created`, `existing`, `off` or `missing`. The starter snapshot is "My Game" (`my-game`); `npm run starter` still overwrites an old snapshot with `mein-spiel`.
- **`ids.lock`.** New files carry an English `note`; old files with `hinweis` still load, and `check` compares only the IDs, so existing games are not rewritten just for the note.
- **`dev`.** Host page labels as in the glossary; problems carry the CSS classes `rules` and `ui`, the frame query is `?seat=`.
- **SDK.** `optionLabel` returns "yes"/"no" (the platform UI does not use it); save errors name the path starting with `save.`. The time format players see (`1:23,4`) stays German.
- **Server.** API messages, log and `admin.js` are English. German stay: push texts, the hint page for a game file opened as a top-level page (players can reach it via "Open frame in new tab"), device labels ("Unbekanntes Gerät") and the name "Gelöscht".
- **Client.** 21 error codes that players can reach got German texts in `texts.ts`. For `game-error` the client takes the incident from the English message, so players keep seeing "(Vorfall …)". The developer texts the client sends to game code (`refused` and the errors of `connectSolo`) are English, like the same texts in `dev`.
- **Tests.** Test titles are English everywhere; the German e2e file names became `dev-realtime`, `dev-single`, `realtime`, `options` and `packages`. Selectors on the German platform UI and the texts of the frozen fixtures stay German.
- **Games.** Mau-Mau, Farbfelder, Mauerbrecher and Angelteich have English READMEs, test titles and CI texts; Farbfelder, Mauerbrecher and Angelteich have the new template `AGENTS.md`, Farbfelder with its own adaptations (who gets a win, its catalog, the German group name "Steuerkreuz"). Game texts, IDs, manifest labels and the German errors inside Mau-Mau's rules stay. Committed locally, no new releases.

**Checked in step 13.** Two independent reviewers compared every translated file with the German version and found no lost content; the meaning errors and inconsistent terms they found are fixed (among them `max`/`min` on profiles, log in/log out everywhere, and wordings in `AGENTS.md` that agents could misread). Every error message quoted in `AGENTS.md` and the READMEs matches the code. An agent with no prior knowledge built rock-paper-scissors from the English `turn-based` template for a German-speaking person: it talked German, wrote README and game texts in German and the code in English, and tests, typecheck, `check` and `pack` were green. What it found about the language rule is now in `AGENTS.md`: manifest labels and screen-reader labels count as texts players read, labels quoted from the example change with the language of the game, and every template says where the agent records its own decisions.

- Open (from the newcomer run, not part of step 13): a pattern to show the other players' counters (the client only gets its own profile, and a copy into `public` in `setup` goes stale), whether an example ID like `wins` may keep its meaning in the new game, how the person can keep using `dev` after the agent stops it, how to try a game on two real phones before publishing (`npm run dev -- --host` is only in the dev tool README), and a hint in the example tests that fixed choices are always in `moves`.

### Arcade UI and multilingual support (steps 11 and 12)

Decided on 2026-11-22 in a grilling session before steps 11 and 12. Replaces "Visual design" and the sentence "The UI is German" in "UI and game client" and refines the paragraph "Redesign planned" there and the points 11 and 12 under "MVP". Both steps touch every text of the UI, so they are planned together, and every page is rebuilt only once.

**Four steps, each with its own review:**

- **12a, language foundation:** a text module per language for the UI, choosing the language including account and push, SDK 0.1.6 with `languages`, `defineTexts` and `cover`, manifest, catalog, `check`, `dev` and templates. The pages keep their look.
- **11, "Neon hall":** every platform page rebuilt once, in the new look and in both languages, on theme variables and exchangeable decorations.
- **11b, themes:** "CRT monitor" and "Arcade front" as optional themes, plus the switch.
- **12b, games:** the four games in German and English with cover images; new releases and catalog entries only after the maintainer's OK; an agent with no prior knowledge makes a game from a template bilingual.

Rejected: the look first and languages afterwards (`cover` and the manifest changes would come in two SDK versions, and every rebuilt page would be touched again for its texts), everything in one step (one very large review in which findings from platform, SDK and games get mixed up) and the themes inside step 11 (layout mistakes would show up three times). Deciding and starting the build happen on the same day; what is not done continues the next day with a hand-over note.

**The look: "Neon hall".** Three drafts of the home page were built and compared by screenshot and intro video: "Neon hall", "CRT monitor" and "Arcade front". The neon hall won: a night-time arcade with an almost black-violet brick wall, neon tube lettering in pink and cyan, a perspective grid floor, and the games as arcade cabinets with a glowing marquee and light strips in the game's color. The look is dark only; the system's light or dark setting no longer matters. The display font Tilt Neon (OFL-1.1, served by the platform itself) is used for the logo, headings, marquees and buttons; body text stays in the system font. Contrasts meet WCAG AA. Rejected: the CRT monitor as the default (pixel font, the monitor frame costs space on the phone), the arcade front as the default (busy with many elements and very bright on a TV in a dark living room), an illustrated pixel-art arcade (a lot of drawing, hard to use on a phone) and a daylight variant of the neon hall (every page twice, and the wow is mostly lost in the light).

**Themes (11b).** After the drafts the maintainer asked to offer the other two as themes. All themes use the same pages and building blocks, so handling is the same everywhere. A theme swaps colors, fonts, frames, background, intro and decorations: the CRT monitor brings the monitor housing, scanlines and the power-on line, with the pixel fonts Press Start 2P and VT323 only for logo, headings, buttons, codes and status lines (body text, forms and the admin view stay in the system font); the arcade front brings the light bulb sign with chaser lights, rooms as tickets and floating sprites, with Bungee and Bungee Shade (all OFL-1.1). Extras of the drafts that change the layout, such as the attract mode with a large cover on the desktop, are dropped. The arcade front is a light theme that one chooses explicitly. Choosing works like the language (see below): the neon hall is the default; the switch is on the account page and, without a login, in the header menu; logged in, the choice is stored with the user and applies on all devices; the TV has its own switch on its pairing page. The fonts of all themes are served by the platform and are in the app's offline cache, so switching also works without a connection. Rejected: full drafts per theme including their layout (tests and upkeep triple, and every new page would be designed three times), themes only per device (choose again on every device and in the iPhone app), a pixel font for body text in the CRT theme (forms, the admin view and long German words read badly).

**Intro on every cold start, short.** When the app is loaded, the lights come on for at most 1.5 seconds: neon tubes flicker on one after another, the cabinet screens switch on. It never blocks; everything can be tapped at once. Switching between pages plays no intro. Rejected: once a day, but longer (the first opening of the day would be different from all others) and a "PRESS START" screen that needs a tap (one tap more on every opening).

**Motion and weaker devices.** The system setting "reduce motion" turns off intro, flickering and chaser lights; glow stays, but static. In addition every device has a switch "Effects" (on/off) next to the sound switch, for old phones or anyone who prefers it calm. During a match no background animations run, so that the game has the full performance. Effects are CSS only, without WebGL or canvas, and with sparing blur. Rejected: only the system setting (an old tablet without that setting would always run everything) and measuring the frame rate during the intro to switch automatically (unpredictable and hard to test).

**Sound off, with a switch.** Short 8-bit sounds on taps, on joining and at the start of a match, off by default; a speaker switch in the header turns them on per device. The sounds are synthesized with Web Audio: no sound files, so no license question and no download. Browsers play no sound before the first tap anyway, so there is no sound in the intro. Rejected: on after the first tap (surprises people in quiet places) and no sound at all.

**Cover image in the manifest.** A new optional field `cover` names an image inside the client folder: PNG, WebP or SVG (SVG because agents without image tools can still write it), aspect ratio 4:3, at most 256 KB. The platform shows it with `<img>`, where an SVG runs no scripts; small images are drawn with sharp pixels. `check` checks that the file exists, its type, its size and its aspect ratio. Without a cover the platform generates one from the ID: a color from a hash, a pixel pattern and the initial. The templates ship a cover; the four games get the pixel-art covers drawn for the drafts (CC0). Rejected: generated images only (all cabinets would look alike apart from color and name).

**Admin view: calm and in tabs.** Same colors, fonts and frames as the rest, but without flickering, chaser lights and intro, with dense, readable lists. The maintainer found the old page overloaded, with sections that were hard to tell apart. It is therefore split into tabs with their own addresses: Games (including catalogs), Users & invites, Rooms, System (quarantined builds, backups); tabs carry counters, for example open invites and quarantined builds. On the phone the tab bar scrolls. Rejected: the full look with all effects (forms and long lists get restless) and one page with clearer separation and a jump bar (stays long).

**Uniform handling on every page.** Every page is rebuilt for its structure, not only its look, and all pages follow the same patterns: the same page header (back, title, menu), clearly bounded sections, the main action always in the same place, the same confirmation dialogs and messages.

**German and English.** Both complete in the UI, push notifications, error messages and the four games. Adding another language means adding one file whose completeness the type check enforces. Rejected: a third language translated by AI (nobody in our own circle checks the texts, and every new line would need three translations).

**Choosing the language: browser, then account.** Without a choice the browser's language applies (German or English, otherwise English). A switch in the header, also without a login, changes it on this device; logged in, the choice is stored with the user (accounts and guests alike) and then applies on all of the user's devices. A TV takes its browser's language and has its own switch on its pairing page. Rejected: only per device (choose again on every new device and in the iPhone app) and only per account (no switch for guests before joining and for TVs; a shared device changes language with the account).

**Every device its own language, also in the same room.** There is no room language: the state of a game holds only IDs, and every device draws in its own language. Rejected: a room language chosen by the host (a guest might not understand the game texts) and a TV that follows the host's language (depends on a person who may not even sit in front of it).

**Push in the user's language.** The service worker keeps building the texts. The server stores the chosen language with the user and the device's language with the subscription, and sends the language along in the payload.

**Games get their language from the platform.** The manifest lists the game's languages in `languages`; the first one is the game's default. The platform picks the language for the game: the platform's language, then the browser's languages, otherwise the game's default. It passes it with the bridge messages (not in the address of the frame, so that the offline cache keeps one entry per file), and `connect` and `connectSolo` offer it as `game.language`. `defineTexts` from the client SDK takes the texts per language and makes a key that is missing in one language a type error; functions cover plurals and parameters. A language change reloads the game. Rules on the server produce no texts for players: the `message` of a rejected move is a developer text, and the game's client shows its own text per code.

```ts
import { connect, defineTexts } from "@gamehearth/sdk/client";

const texts = defineTexts({
  de: { yourTurn: "Du bist dran", cards: (n: number) => (n === 1 ? "1 Karte" : `${n} Karten`) },
  en: { yourTurn: "Your turn", cards: (n: number) => (n === 1 ? "1 card" : `${n} cards`) },
});
const game = await connect<Snapshot, Action>();
const t = texts(game.language);
```

Rejected: passing only the language (every agent builds its own dictionary, and forgotten keys only show up while playing) and JSON files per language (string keys without type checking, and placeholders and plurals need a syntax of their own).

**Translated texts in the manifest sit at the field.** `name`, `description` and every `label` (options, choices, items, stats, flags) are either a text, which then applies in every language (such as "Mau-Mau"), or an object per language. `check` reports an object that lacks a language from `languages` as an error, and plain texts in a game with several languages as a warning. `catalog add` takes name and description from there. Games with `languages`, translated texts or `cover` require `"sdk": "^0.1.6"`, so that older servers do not install them. Rejected: a separate block `translations` with paths such as `options.ace.choices.skip` (error-prone for agents and far away from the original).

```json
"languages": ["de", "en"],
"name": "Mau-Mau",
"description": { "de": "Kartenspiel für 2–6", "en": "Card game for 2–6" },
"stats": { "siege": { "label": { "de": "Siege", "en": "Wins" }, "better": "higher" } }
```

**A game without the device's language** runs in its default language; the game list marks it, for example "German only".

**New games: the person's language plus English.** `AGENTS.md` makes the person's language the first language and English the second; for an English-speaking person only English. The agent deviates only if the person wants it. The templates stay English and get German as an example of a translation (as planned in step 13). Rejected: the agent asks at the start (one more question, and many games would stay in one language) and only the person's language (guests with another language would see foreign texts).

**Error messages in the admin view.** Install errors, manifest errors, incident details and unknown IDs come as English messages from SDK and server (since step 13). The admin view shows a translated sentence per kind of error ("The package is damaged", "The game needs a newer SDK") and below it, expandable, the English message, which an admin can copy to an agent or an issue as it is. Rejected: keeping it English (an admin without English would not understand why an installation fails) and translating everything (dozens of messages in SDK, server and `check` would have to become codes with parameters).

**Texts from the server.** Texts players read that the server wrote in German until now ("Gelöscht", "Unbekanntes Gerät") become codes that the UI translates; the hint page for a game file opened as a top-level page follows the browser's `Accept-Language`. API messages stay English developer texts; the UI shows its own text per error code, as before.

**Formats.** Dates, numbers and the time format of best scores follow the language (`1:23,4` in German, `1:23.4` in English).

**`dev`.** A language selector in the header bar offers the languages of the manifest; all frames, the TV frame included, use the chosen one, and a change reloads the frames.

**Test games.** One test game in `fixtures/` gets `languages`, translated labels and a cover, because the platform tests need them; the others stay frozen.

**Built in step 12a (2026-11-22).** What was settled while building, without changing the decisions above (details in [packages/sdk/README.md](../packages/sdk/README.md#languages), [packages/devtool/README.md](../packages/devtool/README.md), [packages/server/README.md](../packages/server/README.md) and [packages/client/README.md](../packages/client/README.md#languages)):

- **SDK 0.1.6.** `Localized` is a text or an object of language codes (`en`, `de`, `pt-BR`; at most 20 languages per game). `localize` takes the wanted language, then its base language (`de-AT` → `de`), then the given fallbacks, otherwise the first text. `game.language` is the language the platform sends; without one (an older platform) it is the browser's base language, otherwise `en`. `defineTexts` takes the first language written as the fallback, rejects keys that are no language codes at runtime, and checks at the type level that every language has the same keys with the same kind of value (text or function with the same parameters).
- **Manifest and dev tool 0.8.0.** `name` has at most 60 characters. The warning about plain texts leaves out `name`, because game names are often proper names. The cover check (`coverProblems`) is shared by `check`, `pack` and the server's package check: the file must exist in the built client folder, its content must match its extension, at most 256 KB, 4:3 within ±3 %; an SVG's size comes from `width`/`height` with the same unit, otherwise from `viewBox`. `dev` keeps the chosen language on its server (`POST /__dev/language`), so separate windows of seats and the TV follow it. `new` also puts the plain name into the example's `client/src/texts.ts`.
- **Templates.** `"languages": ["en", "de"]`, every manifest text and every UI text (screen-reader labels included) in both languages, all UI texts in `client/src/texts.ts`, a pixel-art `cover.svg` in `client/public/`. Example IDs and rules are unchanged. `AGENTS.md` has a section "Languages" and the cover in its notes.
- **Server.** Migration v11 adds `users.language`, `push_subscriptions.language` and `catalogs.error_code`. `POST /api/me/language` (accounts and guests) has its own rate limit (20 per minute and address); every user object carries `language`. The push payload carries `lang` (the user's language, otherwise the subscription's, otherwise `en`) and the game name localized with the game's own fallback; posting a subscription again changes its language. Deleted seats come as `name: ""` with `deleted: true`, sessions as `browser` and `system` instead of a German device text, the suggested catalog with its own name "Gamehearth". Invalid catalogs are `catalog-invalid` (before: `catalog-unavailable`), quarantined builds carry their abort counts. The hint page for a game file opened as a page answers by `Accept-Language` (English default) with `Content-Language` and `Vary`.
- **Client.** One text file per language (`src/texts/de.ts`, `en.ts`); `texts` is a live binding that `setLanguage` switches, so the whole UI re-renders in the new language. The device keeps the choice under `gamehearth.language`; a choice made before logging in goes to a user without a language; the TV keeps its choice on the device only. English dates and numbers use `en-GB`. Admin errors no longer disappear as a toast: a box stays until it is dismissed, with the translated sentence and, expandable, the English message ("Meldung auf Englisch", "Original message"); catalog errors and quarantined builds show the same way.
- **Tests.** Playwright runs with `locale: "de-DE"`, so the existing tests keep their German selectors; `e2e/languages.e2e.ts` covers the switch, the account's language on a second device, the language inside a running game (Dorfladen shows it) and the TV. Dorfladen got the translated labels and the cover.
- Not yet: the starter snapshot (written again after step 11, when the templates are final).

Tightened after review 12a (2026-11-22, reviewer with no prior knowledge; regression tests in `packages/devtool/test/languages.test.ts`, `packages/client/test/language.test.tsx`, `admin-games.test.tsx`, `ui.test.tsx` and the type test `packages/sdk/test/define-texts.types.ts`, each with a counter-check):

- **Catalogs stay readable for older servers.** A catalog entry with a name per language made every server before 0.8.0 reject the whole catalog, so it would also have stopped getting updates for all other games. `catalog add` therefore writes name and description in the game's default language; the translations come with the installed manifest. Servers from 0.8.0 on still read objects in hand-written catalogs. This narrows the decision "`catalog add` takes name and description from there".
- **Shared devices.** The device kept the account's language as if it were its own choice, and the next user without a language got it written into their account. Now the device keeps its own choice (`gamehearth.language`) apart from a copy of the account's language (`gamehearth.account-language`, only for starting in the right language), logging out drops the copy and returns to the device's language, and only a choice made while logged out in this session goes to the account that logs in next, never on the TV.
- Names may have up to 80 characters again, as the catalog always allowed; with 60, already published games with longer names could no longer be installed.
- Invalid `languages` (duplicates, upper case) no longer causes a second, misleading message that `languages` is missing.
- Translated texts fall back to the game's default language (the first of its `languages`), not to the first text of the object, also in options and profiles; the push already did so.
- A deleted seat is named in the pause overlay of a realtime match; the install button of an offer with a translated name had "[object Object]" as its label for screen readers; German developer texts (storage full, no permission for notifications) are English; the abort counts of a quarantined build no longer have a wrong German plural.
- Guests see the language switch on the page for joining a room and on invite, setup and reset links, not only on the home page.
- Docs: the server README names the push language correctly (user, then device, then English); in `AGENTS.md` the fix for a missing translation no longer suggests dropping the language, which an agent could have used to drop English against the rule.

**Built in step 11 (2026-11-22 and 2026-11-23).** What was settled while building, without changing the decisions above (details in [packages/client/README.md](../packages/client/README.md#look-the-neon-hall)):

- **Design system.** `<html data-theme="neon">` selects a token block (`src/styles/tokens.css`: colors, fonts, radii, shadows); layout and building blocks (`base.css`, `screens.css`) use only the tokens; glow, backdrop, cabinet skin and intro live in `neon.css`, scoped to the theme and on fixed class names. A theme in 11b is one token block plus a decoration file, without changing page markup. The PWA colors are `#07030f`.
- **Font.** Tilt Neon from `@fontsource/tilt-neon` 5.3.0 (pinned), Latin and Latin Extended; Vite copies the `woff2` files into `assets/`, so they are in the service worker's shell and work offline.
- **Intro.** `main.tsx` sets `data-intro` on a cold load, the app removes it 1.5 s after the first page is ready; only opacity and transform are animated.
- **The grid floor drives in once and then stands** (decided on 2026-11-23). A floor that kept moving cost about 12 % of a CPU core per open page without a graphics card, everything else together about 1 %; with six pages open in the test browser 78 % against 10 % now. The browser tests had become flaky because of it, so they run with full effects again. Rejected: keeping it moving and running the browser tests with reduced motion (effects would be untested in the browser, and weak devices would depend on the switch) and a choppy floor with about 8 frames per second.
- **Motion and effects.** Reduced motion and the switch "Effects" (`gamehearth.effects`) turn off intro, flicker, the arriving floor and the pulsing "Your turn". Endless animations (the occasional buzz in the logo, the pulse) pause after 20 seconds without input. The game frame, the single-player page and the TV's game view set `data-scene="play"` and hide the backdrop; the admin view sets `data-scene="admin"` without any animation. There is no blur behind panels.
- **Sound.** `src/sound.ts`: a blip on main buttons, a jingle on joining or creating a room and at the start of a match; off by default (`gamehearth.sound`), nothing before the first tap or key.
- **Pages.** One page header (back, title, menu or language switch), bounded panels, the main action in a bar at the bottom, the same dialogs, banners and toasts; touch targets at least 44 px, a yellow focus ring. Mute and leave moved from buttons in the lobby into the lobby menu, as in the game frame. Next to the logo hangs a sign "Offen" / "Open". Games are cabinets with the cover as screen; game colors come from a palette of 8 neon hues by a hash of the ID. "My rooms" finds a room's cover by the game's name in the game list, because the room list has no game ID.
- **Admin view.** Tabs `/admin/games`, `/admin/users` (users and invites), `/admin/rooms`, `/admin/system` (quarantined builds, backups); `/admin` shows the first. Counters for open invites and quarantined builds; the error box stays.

Tightened after review 11 (2026-11-23, reviewer with no prior knowledge; regression tests in `packages/client/test/review11.test.tsx`, `language.test.tsx` and `packages/server/test/languages.test.ts`, each with a counter-check):

- "My rooms" matched rooms to games by display name, so two games with the same name in one language showed each other's cover and color. The server now sends `gameId`, `languages` and `cover` with every room in `/api/me/rooms`.
- On a phone the admin tabs scrolled behind an invisible scrollbar, and the tab "System" with its counter was cut off; the tabs now form a 2 × 2 grid on narrow screens, and their focus ring is no longer clipped.
- Long game names were cut on the cabinets; they now take up to two lines and carry the full name as a tooltip.
- On the join page the keyboard went from the name to "Join as guest" at the bottom and back up to "I have an account"; the join button now follows the sign-in card in the page.
- Input borders reach 3:1 against the panels, the marquee glow is weaker so that the names keep 4.5:1, buttons in the bars are 44 px high.
- A tap within the first 1.5 seconds played the intro on the next page; the first page change inside the app now ends it.
- Found while building 11b: an account with its own language kept a language chosen while logged out, and a later account without one got it; it is now dropped.
- New tests for what was untested: tab counters after creating an invite, the calm admin scene, every animation behind "reduce motion" and "Effects", and silent sound before the first tap.

**Built in step 11b (2026-11-23).** What was settled while building, without changing the decisions above (details in [packages/client/README.md](../packages/client/README.md#look-the-neon-hall) and [packages/server/README.md](../packages/server/README.md)):

- **Server.** Migration v12 adds `users.theme`; `POST /api/me/theme` takes `neon`, `crt`, `front` or `null` and shares the rate limit of the language; every user object carries `theme`.
- **Choosing.** `src/theme.ts` follows the language exactly: `gamehearth.theme` is the device's own choice, `gamehearth.account-theme` a copy of the account's theme for starting in the right look, with the same rules for shared devices; the TV keeps its choice on the device. A switch sets `data-theme` and the `theme-color` and `color-scheme` metas at once, without reload and without intro. The switch is a radio group with preview swatches: a list on the account page (card "Language, look, sound and effects"), swatches in the header of the logged-out home page and on the TV's pairing page.
- **Themes.** Each theme is a token block in `tokens.css` and a decoration file (`crt.css`, `front.css`); the shared components got two decoration elements that stay hidden in the other themes (`.glass` in the backdrop, `.bulbs` around the logo). In the arcade front, game names sit below the cover and the game frame stays dark. Fonts from `@fontsource` (pinned): Press Start 2P and VT323 for the CRT monitor, Bungee and Bungee Shade for the arcade front, all OFL-1.1, Latin and Latin Extended, in the service worker's shell.
- **Cost.** Measured with six home pages open and effects on, in percent of a CPU core without a graphics card (logged out / logged in): neon 7 / 18, CRT 4 / 6, arcade front 7 / 8. The first version of the arcade front cost about 108 %: 40 separately animated bulbs and a wobble inside masked tickets. The bulbs now light up in three alternating rows, the star and the "Your turn" burst move in steps, the tickets have no mask.

Tightened after review 11b (2026-11-23, reviewer with no prior knowledge; regression tests in `packages/client/test/review11b.test.tsx`, each with a counter-check):

- A TV on a device where an account was logged in (for example after "Use this device as TV") started with the account's copy of theme and language and forgot its own choice after a reload. A TV now starts from the device's own choice only; this also fixes the same slip in the language from step 12a.
- In the arcade front the ink focus ring vanished on dark surfaces (the card for joining with a code, the overlays of a running match: 1.1:1), and the code field lost its yellow ring; both now show yellow.
- The admin view of the CRT monitor used the pixel fonts, with list buttons at an 8 px cap height; it now uses the system font, as decided.
- The blinking "Your turn" chip of the CRT monitor dimmed to 3.5:1; it now dims only to 0.75 opacity. The server README names `theme` in the user object.

**Follow-ups to step 11 (2026-11-23, after the rollout).**

- With the grid floor standing after the intro, the switch "Effects" hardly changed anything visible. Decided: the hall gets cheap effects on small areas, so that it stays alive and the switch shows: the "Open" sign and now and then a cabinet's marquee flicker in steps (the CRT monitor flickers its plate and game names the same way). A smooth "breathing" of the cabinets' light strips was tried and dropped: with six pages open it cost 94 % of a CPU core without a graphics card, the stepped flickers about 1 % (neon 8 % instead of 7 %). A test allows endless animations only in steps, apart from the small pulsing "Your turn" chip and the buzzing logo letter. Rejected: keeping it calm and moving the switch to the account page, and turning off the glow with the effects (departs from "the glow stays").
- The logo fits the themes. Three drafts of an app icon were compared (a joystick whose ball is a flame, an arcade cabinet with a fire on its screen, a neon "G" with a fire on its crossbar); the maintainer chose the flame joystick: games and hearth in one object, clear even at 16–24 px. The app icon (also maskable) shows it as a neon sign on a dark brick wall and replaces the brown icon from step 5. The mark left of the wordmark is drawn per theme: neon tubes, CRT pixel art, an arcade-front sticker with bulbs (on phones the arcade front shrinks mark and wordmark so that both fit). The three marks are inline SVG without styles, so they pass the platform's CSP and work offline; CSS shows the one of the current theme.

**Built in step 12b (2026-11-23).** The four games speak German first and English second, with their pixel-art covers from the drafts, SDK 0.1.6 and dev tool 0.8.0 in `vendor/`: Mau-Mau 0.4.0, Farbfelder 0.4.0, Mauerbrecher 0.2.0, Angelteich 0.2.0. Tests, `check` (no errors, no warnings) and `pack` are green in each repo; committed locally, without release, tag or catalog entry. What was settled while building:

- Messages of rejected moves and other developer errors are English (Mau-Mau, Mauerbrecher); IDs, option values, save formats and the values of profile flags stay as they were, so existing profiles, saves and rooms keep working.
- Mau-Mau's card corners follow the language (B/D/K/A, J/Q/K/A); "1 Karten" became "1 Karte". Angelteich's names of fish, rods and rarities moved from the rules data into `texts.ts`. Mauerbrecher's thousands separator follows the language.
- Farbfelder, Mauerbrecher and Angelteich have the current template `AGENTS.md` plus their own sentences (only Farbfelder had some: its catalog, wins for the most squares, the group "Steuerkreuz"/"D-pad").
- The catalog repo has the new tarballs; all published versions still pass `catalog check` with dev tool 0.8.0.

Tightened after review 12b (2026-11-23, reviewer with no prior knowledge; no blocking defects, IDs, option values, save formats and German texts unchanged apart from the intended singular fixes):

- The tarballs in the games and the catalog came from before the fixes of the acceptance run, so two different artifacts were called dev tool 0.8.0 and SDK 0.1.6. Because neither is published, they were packed again from the final state and put into all four games and the catalog, with the new integrity values in the lock files (`npm ci` green in all five); the games' `AGENTS.md` follow the current templates.
- Decided on 2026-11-23: Farbfelder, Mauerbrecher and Angelteich describe their game, so they get English names (Color Fields, Wall Breaker, Fishing Pond), as the rule for titles says; German stays the default, Mau-Mau stays a proper name. The release workflows take the name in the game's default language, so release titles stay German. Rejected: keeping them as proper names (English players would see words that mean nothing to them).
- Angelteich said "Du hast sich eine Bambusrute gekauft!" for one's own purchase (an old slip, now "Du hast dir …"), and its README named the English button "Collection book" instead of "📖 Book".

**Acceptance run (2026-11-23).** An agent with no prior knowledge got a folder freshly created with `new --name "Höher oder tiefer"` and a German request from a person who doesn't program, without a word about languages. It built the game in German and English on its own (from the rule in `AGENTS.md`), with tests, type check, `check` without warnings and `pack` green, and looked at both languages in `dev`. What it found is fixed (regression test in `packages/devtool/test/new.test.ts` with a counter-check):

- After `new --name` the template's UI test still expected the example's name and failed on a fresh game. The templates' tests now compare language blocks instead of names and check that the first block of `defineTexts` matches the first of `languages`; a monorepo test runs each template's UI test in a game with its own name.
- `dev` showed profile boxes and a line about `dev-profiles.json` also for games without `items`, `stats` and `flags`; both are gone for such games.
- `AGENTS.md` and the SDK README now say: Playwright belongs in a folder outside the game; the invisible buttons are pressed with `focus()` and Enter or `click({ force: true })`; `#state` on the page of `dev` holds the state; a single seat should also be checked at 320 × 568; a title that describes the game is translated, a proper name is not; the blocks in `texts.ts` follow the order of `languages`; without IDs `ids.lock` may be deleted; `package.json`'s `description` is English; and how to test a rule with a fixed card order (`refreshMatch` after changing `match.state`).

### Draw and guess (steps 14 and 14b)

Decided on 2026-11-24 in a grilling session before step 14. Refines "Realtime, roles and TV" (the TV becomes optional per game) and the rule that `legalMoves` lists every move individually.

**Game 5 is a party game of the genre "draw and guess".** In turns one player draws a word on their phone, the others watch the drawing appear and type guesses; whoever guesses faster gets more points. The maintainer named skribbl.io as inspiration and asked for better UX, a nicer look and a consistent design for phones. It is an original game of the genre with its own name, look, word lists, texts and layout. Nothing is taken from skribbl.io: no name, graphics, avatars, sounds, texts, word lists or screen layouts; only the mechanics of the genre are shared.

**What the platform lacked:**

- A move had to be listed exactly in `legalMoves`. A typed guess or the points of a stroke cannot be listed.
- Turn-based games have no time limits; only realtime ticks can end a turn on their own.
- Realtime frames carry the whole snapshot 20 times per second to every device. A drawing of 5–20 KB would cost every phone 100–400 KB/s, on mobile data up to about 30 MB per drawing turn.
- A game with role `screen` cannot start without a paired TV, and a missing TV pauses the match.
- No change needed: QuickJS lowercases umlauts, uppercases `ß` to `SS` and knows `normalize("NFD")`, so comparing guesses is game code.

**Two steps.** Step 14 is the platform: free inputs, delta frames, an optional TV, the on-screen keyboard, docs and templates, plus a test game in `fixtures/`. Step 14b is game 5, built by an agent with no prior knowledge from `new --template realtime`, then a review and a whole match via Playwright. Each step gets its own review. Deciding and building happen on the same day. Rejected: three steps (free inputs, bandwidth and TV each on their own; one more round, and the game would come later).

**Realtime.** Timers, hints after time, the automatic choice of a word and the change of drawer run in `tick`; strokes and guesses are inputs. Rejected: turn-based (it would first need time limits per move, which are deliberately missing, and it would write every chunk of a stroke together with the state to SQLite, about ten times per second).

**The pause stays.** As in every realtime game, the match pauses when a seat has had no visible phone for 2 seconds. With six to eight people this happens more often, but nobody misses a drawing or their turn to draw. Rejected: playing on without those who are away (the rules would have to know who is present: a new field in `ctx`, simulated absence in `check`, skipping absent drawers).

**Joining later stays deferred.** Whoever comes later joins in the lobby after the match (a new round in the same room); a match takes about 10 to 20 minutes. Rejected: building it now (a new game function `join(state, seat)` and seats added to running matches, a large platform step of its own).

**Free inputs as placeholders in `legalMoves`.** Instead of a fixed value, a move in `legalMoves` may contain a placeholder: `text({ min, max, chars })` for a text and `int({ min, max })` for an integer, both from `@gamehearth/sdk`.

```ts
legalMoves(state, player) {
  if (isDrawer(state, player)) {
    return [
      { type: "stroke", color: int({ min: 0, max: 9 }), points: text({ max: 2000, chars: pointChars }) },
      { type: "undo" },
      { type: "clear" },
    ];
  }
  return [{ type: "guess", text: text({ min: 1, max: 40 }) }];
}
```

The platform checks a move against the placeholders without running game code (length, allowed characters, range), and `apply` gets the concrete move. Bots in `check` and `dev` and the trial match fill placeholders with random values, so `check` finds crashes on garbage input. The leak check stays as it is, because placeholders hold nothing hidden. The client sees the placeholders in `moves` and knows from them what it may send. Rejected: a sixth function `validate(state, action)` (game code on every check, and bots would not know which moves exist, so `check` could never test guessing).

**Delta frames.** In realtime the server sends every connection only what changed since the last snapshot it delivered to it, for growing texts and lists only the appended part. The platform client puts the snapshot back together and passes the whole snapshot into the iframe as before. Games notice nothing, and every realtime game profits. Rejected: leaving it as it is (fine on Wi-Fi at home, expensive and draining on mobile data; the game would have to keep its drawing tiny).

**Optional TV.** A role `screen` can be marked `"optional": true`. The match then starts without a TV, a missing TV does not pause it, and pairing works as before. Game 5 has the roles `player` (everyone on their own phone) and an optional `screen`. Rejected: phones only (no big screen in the living room) and a mandatory TV as in Farbfelder (no game without a TV, for example when travelling).

**On-screen keyboard.** The platform page gets `interactive-widget=resizes-content` in its viewport, so that on Android the game frame shrinks when the keyboard opens and the game lays out drawing and input field in the rest. iOS instead scrolls the input field into view; a game keeps the input field directly below the drawing for that. Safari on a real iPhone is checked by hand.

**Templates and docs.** The SDK README, the dev tool README and the templates' `AGENTS.md` describe placeholders, the optional TV and what delta frames mean for the state; the example games stay as they are. A test game in `fixtures/` covers placeholders, a growing text in realtime and the optional TV in server, `check` and browser tests. The acceptance run of step 14b shows whether the docs are enough.

**The game: Kritzelkiste / Doodle Box** (ID `kritzelkiste`). The name describes the game and is therefore translated. German is the first language, English the second. 2–10 players, each on their own phone, a TV optional. Rejected names: "Blitzskizze / Quick Sketch" and "Kritzelei / Doodle Dash" (the latter is a common name of other games).

- **Look: draft A "Skizzenbuch" (sketchbook).** Three drafts in phone size (390 × 844 including the platform bar) were compared by screenshot, each with the screens drawing, guessing, guessing with the keyboard open, and a correct guess: A sketchbook (warm paper, colored pencils, sticky notes, light), B chalkboard (dark, chalk, a chalk box that opens from below) and C neon pen (the platform's neon look, a swipeable color wheel, guesses as bubbles over the drawing). The maintainer chose A. The tools sit fixed in the thumb zone below the sheet, and the drawer sees the word on a sticky note. The hint is a row of graph-paper boxes under the sheet, and guesses are notes, wrong ones crossed out. With the keyboard open, the sheet shrinks and the notes fold into one line. A correct guess gets a green tint, a stamp "Richtig! +120" and paper confetti. The draft goes into the game repo under `docs/draft/`. Rejected: B (one tap more for every change of color) and C (bubbles briefly cover the lower edge of the drawing, and the game would look like the platform).
- **Options:** rounds 1, 2, 3 or 4 (default 2; in one round everyone draws once), drawing time 60, 80, 100 or 120 seconds (default 80), words German or English (default German), own words yes or no (default no). A turn ends at once when everyone has guessed. Rejected: fixed 3 rounds and 80 seconds (about 40 minutes with 10 players) and wider ranges (45 seconds is short for children, 150 drags on).
- **The language of the words is a room option.** Everyone guesses in the language the host chose; the UI stays in each device's language. There are two separate word lists. Rejected: every device in its own language (only words with exactly one translation, hint boxes per language, lists kept in pairs).
- **Choosing the word.** The drawer picks within 15 seconds from one easy, one medium and one hard word; otherwise one is drawn at random. Points count ×1, ×1.5 and ×2. Children take the easy one, adults can gamble. Rejected: difficulty as a lobby option, and a random word without a choice.
- **Hints.** The boxes show length, spaces and hyphens from the start; at 50 % and at 75 % of the time one random letter is revealed, at most a third of the word. Rejected: only the length, and hints as an option.
- **Points.** A guesser gets 50 plus up to 100 according to the remaining time (at once about 150, in the last second about 50), the drawer 30 for every person who guesses the word; both times multiplied by the difficulty. Whoever has the most points at the end wins; a tie gives several winners. Rejected: points by order (no incentive to be fast with two players).
- **Tools.** 10 pencils (black, gray, red, orange, yellow, green, blue, purple, pink, brown), 3 widths, eraser, fill, undo (stroke by stroke) and clear. Every device computes a fill itself on a fixed image size; at edges, devices may differ minimally. Rejected: no fill (identical on every device, but areas only by thick strokes) and a large set with 16 colors and 4 widths (two rows of colors in the thumb zone).
- **Who sees which guess.** Wrong guesses go to everyone; a correct one appears only as "Mia hat es erraten!" ("Mia guessed it!"). A close guess ("knapp daneben") only the guesser sees, because for everyone else it would be a hint. Whoever has guessed the word can keep writing; that is read only by the drawer and the others who have guessed it. Rejected: silence after guessing, and close guesses for everyone.
- **Own words.** With the option on, everyone types up to 3 words within 45 seconds before round 1. As long as own words of other players are left, the middle choice (counting ×1.5) is one of them; a word is never offered to its author for drawing. When guessing, the author counts as having guessed it already (no points, may chat). Rejected: leaving own words for a later version.
- **Profile:** `siege` (wins, ranked), `schnellster-treffer` (fastest correct guess, format time, lower is better, ranked), `punkterekord` (most points in one match, ranked) and `erraten` (words guessed, a counter). No items. The IDs are German like those of the other own games. Rejected: wins only, and more statistics (more IDs that stay forever).

Proposed by the session and accepted by the maintainer with the summary:

- **Comparing guesses.** Upper and lower case do not matter; `ä`, `ae` and `a` count the same, likewise `ö`/`oe`/`o`, `ü`/`ue`/`u` and `ß`/`ss`; accents, spaces, hyphens and apostrophes do not matter. A word may have alternatives (Rad = Fahrrad). Close means one typo (edit distance 1), from 8 letters on two.
- **Word lists** are written anew for the game, CC0 and suitable for families, about 120 words per level and language.
- **Portrait first;** in landscape the drawing is on the left and the rest on the right. The TV shows in landscape a big drawing, the boxes, the time, the points and the guesses.
- **No Phaser.** HTML and one canvas: guessing needs a real input field for the on-screen keyboard, and drawing needs no engine. Phaser stays the recommended starter stack; the engine is free.
- **The drawing is stored as compact text,** at most about 6,000 points per picture.
- **After every turn** 5 seconds of resolution with the word and the points, at the end a podium. No sound (sound in our own games stays deferred).

**Built in step 14 (2026-11-24).** What was settled while building, without changing the decisions above (details in [packages/sdk/README.md](../packages/sdk/README.md#free-inputs-placeholders), [packages/devtool/README.md](../packages/devtool/README.md), [packages/server/README.md](../packages/server/README.md#realtime) and [packages/client/README.md](../packages/client/README.md)):

- **SDK 0.1.7 and dev tool 0.9.0**, with every exact pin, the templates (`^0.1.7`, `^0.9.0`) and the lock file. Free inputs were built in the lead session, delta frames and the optional TV by two agents in their own worktrees, merged into `main`.
- **Placeholders.** `text({ min, max, chars })` (`max` at most 8,000 since review 14, `chars` at most 1,000 characters without control characters) and `int({ min, max })` come from `@gamehearth/sdk`. They are typed as `string` and `number`, so `legalMoves` keeps the type `Action[]`; at runtime they are `{ $text: … }` and `{ $int: … }`. An object with `$text` or `$int` and further keys is an error in the game code, as is a placeholder with invalid limits. Fixed moves are compared as before; a move matches a placeholder move when it has the same fields, equal fixed values and fitting values. Texts are counted in Unicode characters and normalized to NFC before `apply` sees them; without `chars` they may hold no control characters or line breaks. The platform entry has `legalMoveFor`, `sampleMove` and `placeholderTexts`; the client entry has `isPlaceholder`.
- **Bots and `check`.** Bots in `check` and `dev`, the decoy match and the server's trial match fill placeholders with random values: texts of every allowed length from letters, digits, umlauts, emoji, punctuation and spaces (or from `chars`), numbers often at the edges. `check` reports placeholders in a game whose manifest asks for less than `"sdk": "^0.1.7"`; it notices them while playing, not from the manifest. A text that a bot typed may be in several players' areas and in `secret` without a leak warning (games route typed texts on purpose, for example a chat among those who have guessed); next to `public` it is still reported.
- **Optional TV.** Only `roles.screen` may carry `optional`, it needs the role `player` (with controllers only, nobody would see the game without a TV), and it needs `"sdk": "^0.1.7"` as soon as the field is there, also with `false`, because older servers reject unknown fields. `catalog add` leaves `optional` out of the roles it writes, so that older servers keep reading the catalog (as with translated names in review 12a); the installed manifest keeps it. The server distinguishes "has a TV role" (pairing, room list) from "requires a TV" (start, pause); the room's game info carries `screenOptional: true`. The game list says "jeder am eigenen Gerät, Fernseher optional" ("everyone on their own device, TV optional"), and the TV card in the lobby says "optional" instead of "needed to start".
- **On-screen keyboard.** The viewport of the platform page has `interactive-widget=resizes-content`; nothing depended on the old value. Checked only by reading the CSS: the game frame is `position: fixed` and shrinks with the viewport, the main action bar sits above the keyboard. Not tried on a real Android phone or iPhone.
- **Delta frames.** The shared module `jsonDelta`/`applyJsonDelta` in `@gamehearth/sdk/platform` knows the operations `set`, `delete`, `append` (texts), `push` and `truncate` (lists) on paths of keys and indices, and replaces a part as a whole when that is shorter. Applying checks the shape, never changes the base and treats keys like `__proto__` as ordinary data. A client announces deltas with `deltas: true` in `hello` or `screen`; old cached UIs and TVs without the flag get whole snapshots as before. The server keeps per connection the snapshot it last handed to the socket, keyed by room and seat; a frame skipped because of a slow connection leaves it as it is, and every `room` or `screen-room` message with a snapshot replaces it. Each tick computes one full frame per seat and one delta per seat and base. The delta frame is `{ "type": "frame", "base", "delta" }` with the version of the base; if it does not fit, the client keeps its snapshot and sends `resync` once, and the server then forgets the base, so the next frame is whole. Measured with a drawing of 10 KB that grows by 40 characters per tick: 259–263 bytes per delta frame instead of 10.2–10.4 KB.
- **Test game Notizblock** (`fixtures/notizblock`, 1–4 players, typed notes, a growing text of ink, an optional TV) covers placeholders, delta frames and the optional TV in `check` and in the browser test `e2e/notizblock.e2e.ts`: two phones start without a TV, type with the button and with Enter, a too long note is rejected, frames stay under 600 bytes while the ink grows to 2,400 characters, a TV paired in the middle of the match shows everything, and closing it pauses nothing.
- **Forms do not submit in the game frame.** Found in the browser test: the frame is sandboxed without `allow-forms`, so a `<form>` never fires `submit`, and Chrome logs "Blocked form submission". A UI for typing listens to the click of its button and to Enter itself; the SDK README and the templates' `AGENTS.md` say so. Rejected: `allow-forms` in the sandbox (a game could then send forms to other servers).
- **Inputs the platform drops.** More than 4 waiting inputs per seat and tick answer the oldest with `too-many-inputs`, more than 30 per second with `rate-limited`. Clicking quickly in the browser test lost one input; inputs that must not get lost, such as ink or the points of a stroke, are collected and sent again by the client. The SDK README and the realtime template say so.
- Open: the page of `dev` for a single seat (`/p1`) has no `interactive-widget` yet; `room` messages still carry the whole snapshot, so a game that writes profiles in every tick gains little from delta frames; the bridge serializes the whole snapshot for the game frame in every frame (phone CPU, not bandwidth).

Tightened after review 14 (2026-11-24, reviewer with no prior knowledge of the code and docs of step 14; no blocking defects; regression tests in `packages/sdk/test/placeholder.test.ts`, `delta.test.ts` and `packages/devtool/test/check-placeholders.test.ts`, each with a counter-check):

- A game with `text({ max: 16000 })` could not be installed: a bot text at full length with umlauts, emoji or quotes needs more than 16,384 characters as JSON, and the trial match failed with `illegal-move`. `max` is now at most 8,000, and `legalMoves` reports a move whose placeholders could make it longer than 16,384 characters when filled (counting 2 per text character), for example two texts of 5,000.
- A typed text that NFC stretches (such as U+1D15E) passed the server's check of the raw move, became too long when filled, and the sandbox then rejected it as an incident. A filled move longer than 16,384 characters is now not legal, on the server and in the sandbox alike.
- Delta frames kept the old order of an object's keys when a game rebuilt the object in a different order (a ranking sorted by points), so phones with delta frames could show a different order than old UIs or `dev`. If the order changes, the whole object is sent; the round-trip tests now compare the order too. "Games notice nothing" holds again.
- The leak check skipped a whole small object as soon as one of its texts was typed, and so also a hidden card next to a typed note. Now an object counts as typed only if all its texts were typed. That the move check of the leaks stays as it is (decided above) holds; the copy warnings got the exception for typed texts, and the docs say that `check` cannot know who may read a typed text, so the game's own tests have to show it (for game 5: own words and the chat among those who have guessed).
- `chars` may no longer contain characters that NFC changes (such as U+212B, the Ångström sign); no typed text could ever match them. The SDK README counts code points correctly (a flag or an emoji with a skin tone is two), and the dev tool README gives phones in `dev` the role `player` when the game has it.

**Built in step 14b (2026-11-24).** An agent with no prior knowledge built Kritzelkiste in a fresh folder from `new --template realtime`, with the decisions above and draft A in `docs/draft/`, without access to the platform code. Tests, type check, the full `check` (no errors, no warnings) and `pack` are green; the repo is committed with the identity `hearthbit`. With the maintainer's OK it was published on the same day as `hearthbit/gamehearth-kritzelkiste` with release v0.1.0 and added to the Gamehearth catalog. What it settled itself is in the game's README under "Decided by the agent, please check"; among it:

- **"Passen" (pass):** the drawer can end the turn with two taps. Besides the case of an undrawable word, `check` needs it: its bots never guess right, and without passing a match with many players would last longer than 10 minutes of game time.
- **Picture format:** the picture is one text in `public` that grows at the end: a stroke is `!`, one character for color and width (or the eraser) and 4 characters per point on a fixed 600 × 600 grid; a fill is `*`, a color and one point. Undo and clear cut the text back. The drawer's phone keeps its own copy and sends only what the server is missing, one input at a time; every piece carries its stroke and first point, so a repeated or lost piece is harmless. Watchers replay the picture about 140 ms behind, spread evenly over the time it took to draw. Every device fills on its own 600 × 600 raster of color indices, so fills cover the same area everywhere.
- **On-screen keyboard:** a plain `<input>` with 18 px and `enterkeyhint="send"`, sending on click and Enter, no `<form>`. While it has focus in portrait, the layout moves into the top half as in draft image 3: smaller sheet, time beside it, the notes folded into one line, the field below. The send button does not take focus, so the keyboard stays open between guesses.
- **No Phaser, no font of its own.** The handwriting comes from the device's fonts (Segoe Print, Noteworthy, Bradley Hand, Coming Soon, cursive); it looks somewhat different per device. Shipping a free handwriting font (OFL) is left to the maintainer.

What the agent found about the instructions and the dev tool, fixed in the platform (regression test in `packages/devtool/test/cli-build.test.ts`, with a counter-check):

- `check` accepted `--max-seconds`, but `pack` always ran it with 10 minutes; `pack` now passes `--max-seconds` on. `AGENTS.md` says what a game with rounds of its own does: a way for bots to end a phase early, or `--max-seconds` in both scripts.
- The docs relied on error answers to resend lost inputs, but during a pause the platform answers `{ ok: true }` and keeps only the last input per seat. The SDK README and `AGENTS.md` now describe repeatable inputs that carry their position, and a UI that compares its own copy with the state.
- A `/p1` window next to the page with all seats runs the same seat twice; `AGENTS.md` says the UI has to cope with that. `#state` in `dev` is filled in realtime only while "Whole state" is expanded, and `/p1` keeps the header of `dev` above the frame; both are in `AGENTS.md` now.
- It had avoided `<form>` from the start because the game's CSP in `dev` shows `form-action 'none'`; the hint about forms (found in the Notizblock browser test) reached it during the run.

**Acceptance on the platform (2026-11-24).** Via Playwright (a test kept outside the repo): a fresh platform installs Kritzelkiste from a local catalog (the trial match fills the placeholders), and three phones at 390 × 844 with touch play two whole matches: Anna (German, draws with touch events), Ben (German, draws with the mouse) and Clara (English UI); the first match with German words, the second with English ones. In every turn the drawer picks a word, draws, the drawing arrives on the other phones, one guesser types a wrong guess (seen by everyone), the other a close one (seen only by them), both then guess right (stamp and confetti, the word never public), the reveal follows, and the match ends on the podium.

Tightened after review 14b (2026-11-24, reviewer with no prior knowledge of the game; every finding verified with the reviewer's probe; regression tests in the game's `test/review.test.ts`, all 16 red against the code before the fixes). The game agent fixed:

- **Own words of two authors.** When two players wrote the same word, only the first counted as its author; the second could be offered it as drawer or guess it for points and a fastest guess. A pooled word now has a list of authors.
- **"Close" was a substring search.** "Kreis" was close for "Eis", "Schutzhelm" for "Hut", and one private guess like "haus baum sonne mond stern ball" tested six words at once. Now the whole guess, each of its words and each pair of neighbouring words is compared with the normal typo limit; a guess with more than 3 words (or more words than the answer) is shown only to the guesser and says nothing about the answer.
- Smaller points: a private close guess raised the public counter of guesses, so everyone saw that someone was close; the difficulty stood in `public` and halved the candidate words; an own word could also come from the list in the same choice; the order of drawers was rotated instead of drawn by lot; "ß" alone passed as an own word, and Þ/Ð were dropped in the comparison ("Thor" was a miss for "Þór"); 1 of the 6,000 points per fill let a modified client freeze all devices with fills and undo (now at most 100 fills per picture); during a pause the drawer's phone resent the same piece on every answer (now only after 300 ms without progress); the author did not see which of their words was being drawn; "rubber" came first for the English eraser.
- Decided by the session: if nobody has scored, nobody wins and nobody gets a win (before, everyone won at 0 points, so passing earned wins). In the README of the game as a point to check.
- From the first acceptance run: whoever has guessed now sees the word in green in the boxes, as in draft A, and during the reveal the header says "Auflösung" / "The answer" instead of who is drawing.

The second acceptance run on the platform found one more fault: the equivalence of `ue` and `u` (meant for German spellings like "Kaese") also applied to English words, so the swap "mosue" for "mouse" became a public miss. It now applies only to German words (regression test in the game's `test/review.test.ts`, red before the fix). After that, both matches of the acceptance run passed again.

Found while publishing (2026-11-24): the release workflow of the templates took `name` from the manifest as it is, so a game with a translated name would have got the release title "[object Object] 0.1.0"; the four own games had been fixed by hand in step 12b, the templates not. The templates now take the name in the default language, like the games (regression test `packages/devtool/test/release-workflow.test.ts`, red before the fix). The README of Kritzelkiste is English like those of the other own games, and its manifest names the repository.

Found after publishing (2026-11-24, dev tool 0.9.1): `check` of Kritzelkiste seemed to hang under Windows after the bot matches. It was replaying in QuickJS without any output: every variant at least once per player count, so 9 variants times 8 player counts made 72 realtime matches of up to 2,500 ticks each, more than 10 minutes locally and about 6 minutes in CI. Now the first matches per player count (default 10, realtime 2) are replayed as before, and every variant not yet among them only once in total, with the fewest players where it was played; for Kritzelkiste that is 23 matches. `check` and `pack` show the progress as `QuickJS: done/total matches`.

### Bots, playing on and sound (steps 15 and 15b)

Decided on 2026-11-24 in a grilling session before step 15, "features for game nights". Of the four candidates that were deferred, three are built: bots for empty seats, playing on in realtime without seats that are away, and sound in our own games. Joining running matches stays deferred: rounds are short, and whoever comes later joins in the lobby between rounds. Refines "Player count and lobby" (bots and handing over seats), "Realtime, roles and TV" (the pause) and "Arcade UI and multilingual support" (the sound switch).

**Two steps.** Step 15 is the platform: all three features in one SDK version (0.1.8) and one dev tool version (0.10.0), with server, client, `check`, `dev`, templates, docs and a test game, then one review. Step 15b brings the four published games up to date, with its own review; releases and catalog entries only after the maintainer's OK. Kritzelkiste, which needs playing on the most, takes it over together with sound in a release of its own after 0.2.0. Rejected: one step per feature (three SDK versions, or one that stays open until the end) and one step for platform and games (findings from both get mixed up, as in steps 11 and 12).

**Bots only for games with a `bot` function.** A game may export a sixth, optional function `bot(state, player, moves, ctx)` that picks one of the seat's legal moves; `ctx` has `players`, `random`, `options`, `profiles`, `now` and `away`. Only games with `bot` offer bots. Mau-Mau thus plays a card when it can instead of drawing at random, and a game like Kritzelkiste, whose random moves would be gibberish, offers no bots at all. `bot` is pure like the rest: it must not change the state, and its randomness comes from `ctx.random`, a generator of its own derived from the match, so that choosing a move never changes the match's randomness. In turn-based games, `undefined` leaves the choice to the platform (a random legal move); in realtime it means "no input in this tick". If `bot` throws or picks a move that is not legal, the platform takes a random legal move (turn-based) or none (realtime) and writes it to the log; `check` reports it as an error. Rejected: random legal moves with an opt-in in the manifest (Mau-Mau bots would draw cards they could play, and matches would drag on) and random bots for every game with `bot` as an improvement (games like Kritzelkiste would offer useless bots).

**Where bots sit.** In the lobby the host adds bots until the player count fits (Mau-Mau for two plus two bots, or alone against bots); they count toward the player count and the room's size, and the host removes them like members. In a running match the host can hand seats over to a bot whose member has no connected device, and every member can hand over their own seat ("I have to go, a bot plays for me"). Only that person takes the seat back, with a tap in the room. A seat is never given to someone who comes later; that would be a form of joining running matches. Rejected: bots only in the lobby (whoever leaves still holds up the match) and only as a replacement (no Mau-Mau for two); only the host hands over, also seats of members who are there (whoever has to go must ask, and a host could take a seat away from someone present).

**A bot is an autopilot for the seat.** A handed-over seat keeps its member and profile: the bot plays with the member's profile, and a win goes to them. Bots from the lobby get an empty throwaway profile like guests. Wins against bots count on the leaderboards. Whoever has a bot playing for them gets no "Your turn" push. Rejected: matches with bots write no profiles (clean leaderboards, but no wins at all in Mau-Mau for two with a bot, and items could be used without being used up).

**Bot names** are fixed, playful names per language with a robot sign, such as "Robo-Rita"; the state still only knows seats. Rejected: "Bot 1", "Bot 2" (correct, but bland at a game night).

**Playing on without seats that are away, chosen by the game.** A realtime game may declare `"away": "play-on"` in the manifest. Its match then no longer pauses when a seat has no visible phone; instead the seat counts as away, and the game reads the away seats in `ctx.away` in `tick`, `apply` and `bot` (`legalMoves` follows from the state the game keeps), for example to skip an absent drawer or to end a turn when everyone present has guessed. All other realtime games keep pausing, which is right for action games like Farbfelder and Tag, where whoever locks their phone would lose. `check` simulates seats going away and coming back. Rejected: a button for the host in the pause overlay that works for every game without the game knowing (with eight people the host would tap again and again, and an absent drawer would leave 80 seconds of blank sheet) and both together (twice the work).

**Sound through the platform.** A game plays sounds with `game.sound(…)` from the client SDK: a named sound from a small set in the SDK (such as `"blip"`, `"coin"`, `"win"`) or its own tones from notes. The platform synthesizes them with Web Audio in its own window and only when the device's sound switch is on; `game.soundOn` tells the game whether it is. A research check showed that Web Audio inside the sandboxed game frame works after a tap into the frame, but a TV never gets one, and Safari does not let the platform unlock sound for the frame; the platform's own window, in contrast, can play after one click on the TV's page. So games need no audio code, no sound files and no license question. Rejected: the game plays its own sound and the SDK only reports the switch (every game builds audio itself, and the TV stays silent in Safari) and both (sound files would only work reliably on phones).

**One switch, off by default.** The device's sound switch from step 11 covers platform and games and stays off by default; the menu of the game page gets the speaker switch, so that it can be found at the table, and the TV gets its own switch whose click also unlocks its sound. Rejected: game sound on by default with a switch of its own (two switches, and surprises in quiet places).

**The iPhone's silent switch applies.** The platform leaves the audio session at "ambient": sound only plays when both the app's switch and the iPhone's ringer are on, and music from other apps keeps playing at a game night. The hint at the switch says so. Rejected: the session type "playback" (sound even on a muted iPhone, but it stops music from other apps).

**In the games.** Shared sounds come from the TV, personal ones from the phone; `AGENTS.md` says so. Mau-Mau (plays a card when it can, otherwise draws), Farbfelder (runs to foreign squares and splats) and Angelteich (casts, sells a full bucket, buys the next rod when it can) get a bot and sounds; Mauerbrecher, a single-player game, gets sounds. The templates Card Duel and Tag get a bot and sounds, Mushroom Hunt sounds; none of them declares `"away": "play-on"`, because pausing is right for them.

**Built in step 15 (2026-11-24).** What was settled while building, without changing the decisions above (details in [packages/sdk/README.md](../packages/sdk/README.md#bots), [packages/devtool/README.md](../packages/devtool/README.md), [packages/server/README.md](../packages/server/README.md#rooms) and [packages/client/README.md](../packages/client/README.md)). SDK and server were built in the lead session, the dev tool and the client by two agents in their own worktrees, merged into `main`.

- **SDK 0.1.8.** `bot(state, player, moves, ctx)` with `BotContext` (`players`, `random`, `options`, `profiles`, `now`, `away`); the state, the moves and the profiles are frozen, there is no `ctx.profile`, and the bot's generator is seeded from the match's seed, seat, version and tick. `botMove(game, match, player, { now, away? })` answers `{ chosen: "bot" | "random" | "none", action?, problem? }`; `stepMatch` takes `away` and `bots` and reports replaced bot choices as `bots: [{ player, message }]`. `ctx.away` exists in `apply`, `tick` and `bot`, not in `legalMoves` (the moves follow from the state, and `legalMoves` keeps its old context, so tests with a hand-built context keep compiling). Sounds are a name from 12 (`soundNames`) or up to 16 notes within 2 seconds; the bridge carries `{ type: "sound" }` from the game and `{ type: "settings", sound }` to it, and `PlayerInfo.bot` marks bot seats. Games that use none of it may keep their old `sdk` range; only `"away"` in the manifest requires `"^0.1.8"`, because older servers ignore `bot` and `game.sound` stays silent there.
- **Server.** Migration v13 adds `members.bot` (a bot from the lobby, the lowest free number) and `members.autopilot`. The sandbox tells per build whether the game exports `bot` (the guest's `install` answers it; the server asks once and caches it). Turn-based bots move about a second after every change through `botMove` and the same path as a person's move; a bot choice that is not legal, a failing bot or a failing sandbox call leads to a random legal move and one log line per room, seat and reason (at most 20). Realtime bot seats move inside the tick and never count as missing. The host may also hand a deleted user's seat to a bot. Moves of a person on autopilot get `bot-playing`. Playing on: a seat counts as away after the 2-second grace period, the match pauses only when every seat played by a person is away, and `live.awaySeats` names the away seats.
- **Dev tool 0.10.0.** `check` plays extra matches in which the game's bot plays every seat (10 per player count for turn-based games, 2 for realtime; `--bot-games <n>`, 0 turns them off; a match is replayed with `--seed … --bots`; seeds `check-bots-…`). A bot that throws, picks an illegal move or chooses differently on the replay or in QuickJS is an error, as is a bot match that never ends. For `"away": "play-on"` seats go away about every 10 seconds for about 2 seconds, never all at once, and press nothing while away; the away seats per tick are stored with the match, so the repeat and the QuickJS replay pass the same `ctx.away`. `catalog add` never writes `away` (an entry only copies fixed fields). `dev` uses the game's bot for its Bot switch, shows bot problems as a banner without pausing, has an Away switch per seat for play-on games (the frame is dimmed; `dev` itself never pauses) and a Sound switch in its header (off by default, remembered in the browser) that sends the setting to every frame and names the last sound played.
- **Templates.** Card Duel and Tag have a bot and sounds, Mushroom Hunt sounds, each with tests; `AGENTS.md` has sections on bots, playing on and sound. Their manifests keep `"sdk": "^0.1.6"`.
- **Client.** Ten bot names per language ("Robo-Rita 🤖", "Blechbert 🤖" …, beyond the list with a counter); a person on autopilot shows as "Anna 🤖". The host's "Bot hinzufügen" / "Add bot" is disabled in a full room; removing a bot asks nothing, removing a person still does. The game menu offers "Bot spielt für mich" / "Let a bot play for me" and, for the host, "An Bot geben: Ben" for seats without a connected device, also in the realtime pause; both ask first. While a bot plays for you, an overlay with "Zurück ins Spiel" / "Back into the game" covers the game. Away seats show as "weg: Ben" in the game bar and on the TV. Game sounds are throttled to 12 per second per frame and also play after a tap inside the game frame (the top window's user activation); the switch is a checkbox "Ton" / "Sound" in the menus of the game and single-player pages and on the TV's pairing page.
- **Test game Reihum** (`fixtures/reihum`): turns of 3 seconds, a bot that presses half a second into its turn, `"away": "play-on"` (an away seat is skipped) and sounds. `e2e/bots.e2e.ts` adds a bot in the lobby, starts with Anna, Ben and the bot, turns sound on in the game menu (a stubbed `AudioContext` counts the tones), lets Ben's phone go away without a pause, hands Ben's seat to a bot as host, and Ben takes it back.
- Open: a TV that reloads during a match stays silent until someone clicks its page (its switch is on the pairing page); turning the switch on there again unlocks it.

Tightened after review 15 (2026-11-24, reviewer with no prior knowledge; no blocking defects; regression tests in `packages/server/test/bots.test.ts`, `packages/client/test/review15.test.tsx`, `packages/devtool/test/check-away.test.ts` and `new.test.ts`, each red before the fix):

- A turn-based bot whose move failed in the game (an error in `apply`) stopped for good, and a table of bots stood still until the host aborted. The server now tries up to three other legal moves and logs each failure.
- A person who took their seat back while the bot's move was still in the sandbox lost the turn: the bot's move was written as theirs. The write now checks again that the seat is still played by the same side; otherwise the move is dropped as stale.
- `check` never asked a bot while seats were away, because away seats were only simulated in random matches; a play-on game whose bot crashes with `ctx.away` passed. Bot matches of play-on games now have away seats too, which are left out of `bots`, as on the platform.
- The client still showed "Your turn" (title, badge, vibration) while a bot played the seat; `bot-playing` had no text; a host on autopilot could not resume a paused or halted match, because the pause overlay is hidden behind the autopilot overlay (the menu now offers "Weiterspielen"); handing over a deleted seat asked with "Gelöschts Profil".
- Smaller: a realtime step may now write profile changes for bot moves as for inputs; no bot timer starts after the server stops; the bot test in the realtime template's `AGENTS.md` passes the catalog to `stepMatch`, as the template's test does (a test checks every `stepMatch` example).

**Built in step 15b (2026-11-24).** Four agents updated the published games in their repos, each with SDK 0.1.8 and dev tool 0.10.0 in `vendor/` (packed again from the final state after review 15), tests, type check, the full `check` (no errors, no warnings; it now includes matches played by the game's bot) and `pack` green; committed locally as `hearthbit`, without release, tag or catalog entry. The manifests keep `"sdk": "^0.1.6"` and declare no `"away"`; IDs, options, stats, `ids.lock` and save formats are unchanged.

- **Mau-Mau 0.5.0:** the bot plays a card whenever one fits, keeps jacks until nothing else fits and then wishes the suit it holds most, prefers 7s and 8s against a player with few cards, follows the house rules and reads only the public table and its own hand (a test swaps the other hands and the deck). It beats a random player in about 69 of 100 matches for two. Sounds only for what concerns you: your card, drawing, your turn, a 7 or a skip hitting you, the end.
- **Farbfelder 0.5.0:** the bot decides on every square, heads for the nearest square that is not its own (an empty one counts as three squares nearer, otherwise bots chased each other's trails), splats when at least 5 of the 9 squares around are not its own, and sends a move only when its steering changes (about one input per second). The TV plays start, the last five seconds and the end; the phone only your own splat and "splat ready again".
- **Angelteich 0.3.0:** the bot opens the starter pack, sells the bucket at 5 catches or when the sale pays for the next rod or bait, buys the next rod while keeping 2 coins for bait, buys bait when it has none, otherwise casts; without bait and coins it uses the worm or sits out, so it never gets stuck with any profile. Cast and bite sounds play on every phone for everyone's casts (the game has no TV, and a match against bots on one phone would otherwise be silent); shop sounds only for your own moves.
- **Mauerbrecher 0.3.0:** one sound per frame for paddle, wall, brick hit and broken, extra, life lost, level cleared, the end and a new best score; collision sounds at most 8 per second, so the important ones always fit under the platform's 12.
- `AGENTS.md` of Farbfelder, Angelteich and Mauerbrecher follow the current templates.

Tightened after review 15b (2026-11-24, reviewer with no prior knowledge of the games; no blocking defects):

- A phone whose seat a bot plays kept sending its held input (Farbfelder's controller resends while the figure moves differently), and every answer `bot-playing` showed a toast over the autopilot overlay. Solved in the platform: while a bot plays your seat, the game page answers moves from the game itself with `bot-playing` without sending them and without a toast, and tells the game that sound is off, so your phone also stays silent (regression test in `packages/client/test/game-sound.test.tsx`, red before the fix).
- Farbfelder's `AGENTS.md` had the bot test example without the catalog (fixed as in the template). The lockfiles of Mau-Mau, Angelteich and Mauerbrecher named the integrity of the first packed dev tool; `npm install` does not update it for `file:` tarballs and `npm ci` does not check it, so it was set by hand.
- Kept as decided by the game: Angelteich plays everyone's casts on every phone.

### Publication (step 16)

Decided on 2026-11-25 in a grilling session before step 16. Until then only the games and the catalog were public: the platform repo was private, SDK and dev tool lived as tarballs in `vendor/` of every game, and the starter repo existed only as a local snapshot. Step 16 publishes everything. Resolves "When the platform repo becomes public" from "Still open" and the npm item from "Deliberately deferred".

**Fresh repos with one commit each.** Every public repo (the platform, the five games, the catalog and the starter) starts over with a single commit under the account name and its no-reply address. The development history contained working details that do not belong in public repos; cleaning it would have meant checking every old version of every file, including prose that no search pattern reliably finds. Rejected: rewriting the history and force-pushing (GitHub keeps the old commits reachable by their hash and lists the force push with a link in the repo's activity log) and rewriting the history into fresh repos (the history stays, but every old version of this file would have to be clean).

**The earlier history is kept privately.** Rejected: deleting it (deleting is final, and the history with all its decisions would be lost) and keeping only the platform's history (the small repos cost nothing to keep).

**Order: npm first.** 1. SDK and dev tool on npm, 2. the games and the catalog anew, with SDK and dev tool from npm instead of `vendor/`, 3. the starter repo, 4. the platform, 5. the website. Every repo is created only once and already in its final form. Until step 4 the npm packages link to a repo that is not public yet; that lasts a few hours. Rejected: cleaning up first and moving the games to npm afterwards (every game repo would be touched twice) and leaving the platform private (the AGPL code would still not be visible, and npm and the website would have to link to the starter).

**Every game gets a patch version.** Mau-Mau 0.5.1, Farbfelder 0.5.1, Mauerbrecher 0.3.1, Angelteich 0.3.1 and Kritzelkiste 0.1.1 are the same games; only SDK and dev tool from npm, links, docs and the copyright notice are new. The catalog lists only these versions; the older packages are not carried over. A server shows the update and keeps its installed builds until someone clicks. Rejected: building the current version numbers again (one version number would stand for two different packages) and rebuilding all 13 older versions for rollbacks (a lot of work, and they would not be the original packages either).

**This file in a cleaned version.** Same file, same structure, dates and rejected alternatives; details of a particular deployment are not part of it. From now on this file contains nothing private; details of a particular server belong in that server's own repo. Rejected: restructuring it into a reference and a decision log now (a big rework with the risk of losing reasons; stays deferred) and keeping the file private (outsiders would see the reasons only in the short form of the website, and work would span two repos).

**npm: SDK 0.1.8 and dev tool 0.10.0.** Exactly the versions all games use, with `repository` pointing to the platform repo and the package's folder. From now on npm is the only source, and `vendor/` disappears from the games and the catalog. The first publication is done by hand with a one-time code, because trusted publishing can only be set up for a package that exists. After that, a tag `sdk-v<version>` or `devtool-v<version>` on the platform repo publishes through GitHub Actions with trusted publishing (OIDC, provenance, no token in the repo); pushing the tag stays a deliberate step. Rejected: a fresh start at 0.2.0 and 0.11.0 (all games, templates and manifest ranges would have to follow, because `^0.1.8` does not accept 0.2.0), 1.0.0 (the contract still changes with every step) and publishing by hand forever (no provenance, and every new SDK version needs someone at a terminal).

**A website on GitHub Pages from the platform repo.** A workflow deploys the folder `site/` to `hearthbit.github.io/gamehearth/`, so that the concept and the site change in the same commit. It shows the idea, the components, the architecture as a diagram and a few reasons for each part, plus screenshots taken from a fresh local server with demo accounts by a script in the repo. Look: the neon hall of the platform, but calm like the admin view (no flicker, no chaser lights); English only. Rejected: a domain of our own (costs, and a registration can point to a person), the site in a repo of its own (reasons would have to be kept current across repos), only diagrams (visitors would see neither the platform nor the games), a video (large files for little gain) and German and English (every text twice).

**The copyright notice is "The Gamehearth contributors" everywhere.** The licenses stay: AGPL-3.0 for server and client, MIT for SDK, dev tool, templates and our own games, CC0 for their graphics and for the catalog. The platform gets a notice for the first time. Rejected: the account name (wrong as soon as others contribute) and keeping the mix of both.

**Issues and pull requests are open.** The platform, the games and the catalog each have a short `CONTRIBUTING.md` (open an issue first; contributions are licensed under the repo's license) and a `SECURITY.md` that points to GitHub's private vulnerability reporting instead of an e-mail address. The starter repo stays exactly what `new` creates and points to the platform for issues. Rejected: issues only (seems dismissive) and read-only repos (no way to report bugs).

**Settled while publishing (2026-11-25).** Everything above was done in the planned order; the release packages built by CI are byte-identical with the packages `pack` built locally, and the npm packages with the tarballs that were reviewed before publishing. Before going public, two reviewers with no prior knowledge checked everything that would become public (files, images and their metadata, fonts, lock files, npm packages, repo descriptions) for private details.

- npm stages the first publication of a new package: a public placeholder version `0.0.0-stage` appears at once, the real version follows after a few minutes of automated checks. The placeholders were deprecated afterwards. A new package can only be published from an account with a verified e-mail address, and npm shows the e-mail address of every maintainer publicly; the account therefore uses an address that exists only for this project.
- The unscoped dev tool `gamehearth` belongs to the account that published it, not to the organization `gamehearth`; it appears under the organization only once the organization's team gets access to it.
- After switching the games from `file:vendor/…` to npm ranges, `npm install` kept the old `file:` entries of SDK and dev tool in the lock files; only `npm install <package>@<range>` resolved them from the registry. The lock files were checked for `resolved` URLs outside the registry before publishing.
- Right after a repo is renamed and made private, GitHub briefly rejects pushes to it ("repository is disabled"); a retry a few seconds later works.
- The account's public profile (display name, e-mail, location, bio) is shown next to every repo and is checked along with the repos.
- The website and its screenshots are English throughout: game names in their English form (Color Fields, Wall Breaker, Fishing Pond, Doodle Box; Mau-Mau keeps its name), and the catalog is now called "Gamehearth catalog" instead of "Gamehearth-Katalog", because servers show that name in every language.

### Shadow Stage and music (steps 17 and 17b)

Decided on 2026-11-25 in a grilling session before step 17. The maintainer is a fan of roguelikes and deckbuilders and asked for a game that is clearly more complex than the first five. Refines "Bots, playing on and sound (steps 15 and 15b)" (music next to sounds) and "Single player, saves and offline" (a larger single-player game on the same path).

**Game 6 is "Schattenbühne / Shadow Stage"** (ID `schattenbuehne`), a roguelike deckbuilder for one player. An abandoned travelling shadow theatre: at night the paper puppets wake up and play the last performance against the shadows of their vanished puppet master. A run is three acts of about 15 minutes on a branching act map; fights run on a **timeline** instead of energy (every card costs ticks, whoever is furthest back acts next, enemies announce action and tick). Two puppets in 0.1.0 (Tightrope Dancer, Strongman), about 80 cards, 30 props, 12 tricks, 15 events, 27 enemies; unlocks through an applause bar per puppet and five difficulty levels, shareable run codes and a daily performance. It is an original game of the genre: its name, setting, puppets, enemies, cards, terms and look are its own; nothing is taken from existing games. Its rules and content plan are in the game repo (`docs/concept.md`, `docs/build-plan.md`). Rejected: co-op for 1–4 with a reducer (no offline, solo always through a room) and co-op only (the core of the genre, puzzling alone, would be lost); energy per turn (the most common core of the genre, the game would only differ in content) and a positional grid (cramped on a phone, the hardest to build and test).

**The single-player path is enough.** `connectSolo` carries the game: the run in progress, unlocks, levels, daily results and settings fit into the save (estimated under 16 KB during a fight, at most 64 KB); best scores are `punkte`, `hoechste-zugabe` and `siege` (all `higher`; wins only grow, because single-player games have no counters). The game uses its own seeded generator in `src/` for codes and the daily performance and keeps the generator's state in the save, so reloading never rerolls. Profiles with items and flags are not needed.

**No daily leaderboard.** The daily performance gets its seed from the device's local date and is the same offline for everyone; the game shows the result of the first finished attempt of the day, and the family compares at the table. The platform's leaderboards stay all-time. Rejected: a platform step for best scores per period before the game (manifest field, server, sync and game page; a large step for a comparison that works at the table) and no seeds at all.

**Engine split: Phaser for the stage, HTML for the cards.** The maintainer asked for rich animation. The stage (jointed puppets, lamp light, shadows that grow and blur, particles, shake, curtain) runs in Phaser 4 with WebGL, because blur and light in CSS stutter on mid-range phones; hand, timeline and menus are HTML above it, for sharp text in two languages, screen readers and Playwright. The rules return events for every action, and a "director" in the client plays them on both layers. This keeps "Phaser for everything" as the template's recommendation while showing that a game may mix. Rejected: HTML and SVG only (simpler, but light and blur effects stay plain or stutter) and Phaser only (card text on canvas, no screen readers).

**Music through the platform (step 17).** Games could only play short sounds (16 notes within 2 seconds). A game now plays a **looping track** with `game.music(track)` and stops it with `game.music(null)`; the platform synthesizes it with Web Audio like the sounds: no audio files, no license questions, nothing extra to preload for offline. A track has a tempo, a length in beats and up to 4 voices with at most 256 notes in total and loops of at most 60 seconds; instruments are the four waves plus a few presets (such as a music box, an organ, a plucked string, a bass and filtered noise for wind or crackle). Starting another track crossfades; the same track again keeps playing; music pauses while the page is hidden. Invalid tracks return `false` with a console message, like sounds. The game decides which device plays music (with a TV, as with sounds, shared music comes from the TV). Rejected: audio files in the package (license check in `check`, size limits, preloading, and someone has to find or make free music; stays deferred) and longer sound sequences scheduled by the game (timing drifts, the throttle of 12 sounds per second, and every game would build its own sequencer).

**Music has its own switch.** Next to "Ton" / "Sound" comes "Musik" / "Music", a device setting like the sound switch, in the menus of the game and single-player pages and on the TV. Music plays only when both are on; the music switch is on by default, so turning on sound brings music along, and it can be turned off on its own (on the train, in the living room). Music is mixed quieter than sounds; the iPhone's silent switch applies as before. `game.musicOn` and `game.onMusic` tell the game. Rejected: one switch for both (whoever dislikes the loop would have to give up all sound), which refines "One switch, off by default" from step 15 for music only.

**Step 17 covers** SDK 0.1.9 (`music`, `musicOn`, `onMusic`, validation in the SDK), the bridge, playback and the switch in the client including the TV, `dev` with a music switch in its header that names the playing track, the SDK README and the templates' `AGENTS.md`, Mushroom Hunt with a short loop as the pattern, and a test game in `fixtures/` with a browser test (stubbed `AudioContext`). Games that use music need SDK 0.1.9 as a package; older servers play nothing. Dev tool 0.11.0. Publishing to npm by tag (the first run of trusted publishing), pushing and rolling out each need the maintainer's OK. Step 17 runs alongside the first stages of the game; the game adds music in its last stage.

**Step 17b builds the game in five stages:** rules core, the fight on the stage, act map and stations, content and progress, polish. Each stage is built by a fresh agent that knows only the game repo and the READMEs in `node_modules`, not the platform, created on the public path (`npx gamehearth new --template single` with the packages from npm); each stage gets an independent review, and every finding that holds becomes a regression test. Rejected: the lead session builds with helpers (faster, but with knowledge of the platform, so gaps in the docs show less) and one agent for everything (the game is about five times the size of Mauerbrecher). Repo, release and catalog entry only after the maintainer's OK.

**Look: "Amber light" ("Bernsteinlicht").** Three drafts in phone size (390 × 844 including the platform bar) were compared by screenshot, each with the screens fight, card selected, act map and reward: A Amber light (a lamp behind amber paper, black jointed puppets on rods, a carved frame with a red velvet curtain, cards like old theatre tickets, the timeline as a brass rod), B Moon screen (a cold moonlit cloth in an abandoned theatre, one candle as the only warm light, slate cards with silver edges) and C Coloured parchment (translucent coloured puppets like dim stained glass, colour-coded card types). The maintainer chose A. The draft goes into the game repo under `docs/draft/`. Rejected: B (almost monochrome, card types less distinct at a glance) and C (the least dark, and the puppets lose their shadow character).

**Built in step 17 (2026-11-27).** What was settled while building, without changing the decisions above (details in [packages/sdk/README.md](../packages/sdk/README.md#music), [packages/client/README.md](../packages/client/README.md#music-in-games) and [packages/devtool/README.md](../packages/devtool/README.md)).

- **SDK 0.1.9.** A track is `{ name?, bpm, beats, voices }` with `name` 1 to 40 characters, `bpm` 40 to 240, `beats` a whole number from 1 to 128 (at most 60 seconds), 1 to 4 voices `{ instrument, volume?, notes }` with at least one note each and 256 notes in all; a note is `{ freq, at, length, volume?, to? }` with the sounds' 30 to 8,000 hertz, `at` from 0 to before `beats` and an end by the end of the loop. Added: at most 64 notes per second of loop, so that a one-beat loop with 256 notes cannot flood a phone's audio. A voice defaults to volume 0.5, a note to 1; a track is at most about 40 KB as a message, so no extra size check was needed. Validation (`trackProblem`, `readTrack`) is shared by the bridge, the client, `dev` and tests.
- **The game sends its track even while music is off;** the platform keeps it and starts it as soon as both switches are on, so games set music per scene and never react to the switches. `game.music` returns whether the track plays now, and the SDK sends a track only when it differs from the last one. `settings` carries `music: true` only while sound and music are both on; older platforms leave it out, and `game.musicOn` stays `false` there.
- **One player for platform and `dev`:** `createMusicPlayer` in `@gamehearth/sdk/platform`, typed structurally against Web Audio, so the SDK needs no DOM types. It schedules 0.5 seconds ahead every 100 ms on the audio clock, starts 50 ms ahead, crossfades linearly over 1 second, fades out over 1 second on `null`, keeps at most one track fading (a third change cuts the oldest), pauses with a 0.1-second fade and resumes at the same loop position, and after a stalled main thread jumps to the current position instead of playing missed notes. Instruments: `musicbox` two sines (the note and four times it) that ring at least 0.6 seconds, `organ` one periodic wave with partials 1 to 4, `pluck` a sawtooth through a closing low-pass, `bass` a square through a low-pass at three times the note, `noise` looped white noise through a band-pass at `freq`. A note peaks at `0.05 × voice volume × note volume`, sounds at `0.12 × volume`.
- **Client.** `gamehearth.music`, on by default; "Musik" / "Music" sits after "Ton" / "Sound" in the menus of the game and single-player pages, on the TV's pairing page and, as for every device setting, on the account page. The bridges keep the game's last track and hand it on only while both switches are on and no bot plays your seat; a new `ready` (new round, reload) drops it. Each page has one music channel and closes it when it is left. Before the first user activation the client checks every 250 ms, so music also starts after a tap inside the game frame.
- **Dev tool 0.11.0.** With several frames, `dev` plays only one track: the TV's, otherwise that of the first seat that has one, because several phones would play over each other. The header shows `♪ <name>` (or `♪ music`) only while it plays.
- **Templates.** Mushroom Hunt plays "Mushroom forest" (a music box with nine notes over a quiet bass, 100 bpm, 8 beats) during a level and nothing in the menu, through `sceneMusic` in `client/src/view.ts`, with a test. Card Duel and Tag stay without music; their `AGENTS.md` describe the pattern (in Tag only on the TV). The manifests keep `"sdk": "^0.1.6"`, because music needs nothing in the manifest.
- **Test game.** Sammler got two loops with different waves and a stop button and shows `game.musicOn`; `e2e/music.e2e.ts` runs it against an `AudioContext` stub whose clock follows `performance.now()` and counts the scheduled notes. `e2e/dev-single.e2e.ts` checks the track name in `dev`.
- Open: hiding and showing the page on a real iPhone (where Safari interrupts the audio context) is only covered by resuming the context when the page is visible again; it still needs a check by hand.

### Automated testing

Every multiplayer reducer **must** provide `legalMoves(state, playerId)`. For realtime games it describes the space of possible inputs.

With it, `check` plays hundreds of matches with random bots and reports:

- crashes and invalid states
- matches that never end
- violations of the reducer contract (non-determinism)
- leaks: information from `secret` or from other players' `players[id]` that ends up in `public` or with other players

The messages are worded so that an AI agent can fix them directly. As a by-product, bots emerge that can step in as players.

**How `check` is built (step 3):**

- The game is bundled with esbuild. A first pass without Node modules makes sure that the game does not use `fs` or the like.
- The matches run in worker threads, one per player count in parallel. Through a shared memory area (SharedArrayBuffer), the worker reports phase, seat and move on every call of game code. If this heartbeat stalls for longer than the time limit, the worker is terminated and the location is reported as an infinite loop.
- In the worker, `Math.random()`, `Date.now()`, `new Date()`, `performance.now()` and `crypto` randomness throw an error immediately; the call is also noted in the shared memory, so that a caught error is reported too. Whatever that does not cover is found by replaying every match from seed and moves. During the replay, a second match with a different player count runs in between in the same module, so that state that `setup` keeps outside the match is noticed too.
- Leaks in moves are found by a counter-check: `check` swaps the texts hidden from a player and checks whether that player's moves change. Only then do they depend on secrets; fixed choice lists are left alone. Values that are open and hidden at the same time produce warnings. Neither detects numbers and derived values.
- Warnings for typical AI mistakes that do not crash: a legal move that changes nothing, and a `setup` that always starts the same despite randomness.
- Seeds of the check matches are fixed (`check-<players>-<number>`), so that every run turns out the same and every match can be replayed with `--seed`.
- Since step 4b: as on the server, only what is in the game folder gets bundled, plus the SDK. Per player count, the first 10 matches also run in the server's QuickJS sandbox; `check` compares every state by fingerprint and reports games that fail there (error) or run differently (warning).

## Draft of the game interface

For orientation only, not fixed.

**Manifest:**

```json
{
  "id": "example-card-game",
  "name": "Example Card Game",
  "version": "0.1.0",
  "description": "Card game for 2–6",
  "repository": "https://github.com/name/example-card-game",
  "sdk": "^0.1.0",
  "license": { "code": "MIT", "assets": "CC-BY-4.0" },
  "mode": "turn-based",
  "players": { "min": 2, "max": 6 },
  "server": true,
  "client": "dist/client",
  "roles": {
    "player": { "inputs": ["touch", "mouse"], "screen": "small" }
  }
}
```

`mode` is `single`, `turn-based` or `realtime`. `client` is the ready-built folder with `index.html` (see "UI and game client"). `players` follows the rules from "Player count and lobby". For a party game, `roles` would instead list `screen` (e.g. `large`, no input) and `controller` (`touch`, `small`). Single-player games without a reducer declare their best scores under `stats` (since step 9, see "Single player, saves and offline"). From step 10, `options` and the profile catalog with `items` and `flags` are added (see "Options and profiles from step 10").

**Reducer:** The binding contract is in [packages/sdk/README.md](../packages/sdk/README.md). Summary of the decisions that were added while building the SDK core:

- **Seats instead of people.** In the game, players are called `p1` to `pN`. Which person, guest or bot sits in a seat is handled by the platform. Only this way can a seat be handed to a bot or a new player without rewriting the game state, and names never end up in the state.
- **`apply` only gets legal moves.** The platform checks every move against `legalMoves` (compared as JSON, independent of field order). `apply` may change the state directly or return a new one.
- **Moves are stored.** After every move the platform computes `legalMoves` for all seats once and stores them in the match. Snapshots and move validation run no game code after that; game code runs only in `createMatch` and `applyMove`. That keeps the later sandbox simple.
- **Loud errors instead of silent ones.** Every error in the game code is caught and reported with phase, seat, reason and stack trace; the match stays in the last valid state. Detected are, among others, non-JSON values (Set, Map, Date, NaN, classes, getters, extra fields on arrays), nesting that is too deep, `async` functions, foreign or missing seats, wrong results, write attempts in `legalMoves` and `result`, and matches in which nobody can move without them ending. Infinite loops, memory hogs and expensive built-in functions are caught by the sandbox on the server (see "Sandbox on the server").
- **Objects without a prototype.** Game code gets objects without a prototype, so that keys like `constructor` or `__proto__` are normal data (e.g. in word games).
- **Snapshots as the only interface to the client.** `playerSnapshot` contains `public`, the player's own area `me`, the player's own moves, the version and the result; `screenSnapshot` only public data. The platform deliberately does not reveal who currently has moves, because with some rules that is hidden information (for instance "whoever has the matching card may throw it in"). Whose turn it is, the game puts into `public` itself.
- **Version instead of a move counter.** Every match has a `version` that goes up with every change (later also with realtime ticks). Clients send it along as `expectedVersion`; outdated moves are rejected as `stale`.
- **Randomness with 128 bits of state** (sfc32, seeded via cyrb128). A 32-bit generator could be brute-forced in seconds and would have given away the deck. The server generates seeds randomly and never hands them out. The generator is not cryptographically secure; for one's own circle that is enough.
- **Limits against abuse.** Moves from the client are checked for size (16,384 characters), depth (32) and JSON before any processing, and canonicalized once. `apply` gets the stored move, never the object from the client.
- **Two entry points.** Games import from `@gamehearth/sdk` (only `defineGame` and types). Server, dev tool and tests import from `@gamehearth/sdk/platform`. That way a game cannot accidentally create its own matches or its own randomness.
- **Format version.** Stored matches carry `format: 1`, so that later changes to the format can be detected.
- `tick` for realtime comes with the party game as an additional, optional function (see "Realtime, roles and TV").

## MVP

Three games of our own, each testing a different path through the architecture and at the same time serving as the examples in the AI templates:

| Order | Game | tests |
|---|---|---|
| 1 | Mau-Mau for 2–6 players (traditional card game with hidden hands and a secret deck), each on their own device | Accounts, guest access, catalog install, server reducer, secret state areas, `legalMoves` and bot runs, rooms that persist over days |
| 2 | Realtime party game: the TV shows the field, phones are controllers | Server tick, interpolation, roles, QR join, device manifest |
| 3 | Free single-player game with Phaser, without a reducer | optional path, save and high score, offline play as a PWA, iframe isolation with a real engine |

The card game is the first vertical slice through the platform: it forces the parts that everything else builds on. Realtime and roles then come on top of a stable foundation.

**Order of the first slice.** First the contract, without server and UI, because it is the riskiest piece of the design and can be tested in plain TypeScript:

1. SDK core: types, match runner, seeded randomness, per-player view, player count
2. Mau-Mau as a reducer
3. `check` with bot runs, leak detection and determinism check
4. Server: rooms, WebSocket, SQLite, game version per room. Already designed so that profiles can be added later without rework: history with room for profile snapshots per move, one transaction around every move, recomputing the legal moves on an external event.
4b. Server sandbox, brought forward before step 5: game code runs only in QuickJS in the sandbox worker, bundling limited to the game folder and the SDK, `check` also replays in QuickJS (see "Sandbox on the server")
5. PWA (Preact) with sandbox iframe, `postMessage` bridge and client SDK, Mau-Mau UI in Phaser 4, new round and abort in the same room, first rollout on a real server (see "UI and game client")
6. Accounts and guests: sessions in a cookie, invites, guest joining, admin view, migration of the rooms from step 5, limits and backup (see "Accounts and guests")
6b. Web push ("Your turn" ("Du bist dran"), "Match is over" ("Partie ist vorbei")) to all enabled devices, muting per room (see "Web push"); plus handing over the session to further devices via a code, and the installed iPhone app (see "Continuing on another device")
7. Game package and catalog install: `pack` and `catalog add` in the dev tool, catalogs, install, updates and removal in the server including the admin view, Mau-Mau in its own repo with a release, catalog repo (see "Game packages and catalogs"); until then the server loads games from a local folder
7b. Starter with `AGENTS.md` and template "Card Duel", commands `new` and `dev` (see "Starter, `new` and `dev`"); SDK and dev tool on npm and the public starter repo are postponed
8. Realtime platform: `tick` in the SDK, realtime rooms with pause and snapshot in the server, TV via pairing, roles and devices in the client, smoothing in the client SDK, `check` for realtime (see "Realtime, roles and TV")
8b. Template "realtime" with the example "Tag", `dev` with a TV frame, Farbfelder (game 2) in its own repo, acceptance run by an agent with no prior knowledge
9. Single-player platform: `connectSolo` in the SDK, saves and best scores in the server with sync and leaderboard, packages without a reducer, game page without a room, offline preload (see "Single player, saves and offline")
9b. Template `single` with the example "Mushroom Hunt", `dev` for single player, Mauerbrecher (game 3) in its own repo, acceptance run by an agent with no prior knowledge

**After the MVP:** game options and profiles including the catalog, `ids.lock`, leaderboards from reducer games and `random.weighted` (see "Game data, options and profiles"); best scores as stats for single-player games already come with step 9. Cut before step 10 into (see "Options and profiles from step 10"):

10. Game options and `random.weighted`: manifest, SDK (`ctx.options` in all phases, `update.options`), `check`, server, lobby, `dev`, templates, options for Mau-Mau and Farbfelder
10b. Profile platform: catalog in the manifest, `ids.lock`, `ctx.profile` and `ctx.profiles`, atomic operations and recomputing in the server, own profile in the client, game page with profile and leaderboards, admin view, test game in `fixtures/`
10c. Profiles in the templates (Card Duel with joker and wins, Tag with wins) and in `dev`, wins (`siege`) in Mau-Mau and Farbfelder, game 4 "Angelteich" by an agent with no prior knowledge

**After that:** step 13 comes first (decided on 2026-11-20, see "Docs in English (step 13)") and is built (2026-11-22). Multilingual support and the new UI both touch all texts of the UI; they were planned together on 2026-11-22 and built on 2026-11-22 and 2026-11-23 in the order 12a, 11, 11b, 12b, each with its own review (see "Arcade UI and multilingual support (steps 11 and 12)"). With the maintainer's OK, the four games were released and added to the catalog, on 2026-11-23.

11. New platform UI in the style of a retro arcade, the "Neon hall": every page rebuilt once, in both languages, admin view in tabs (see "Arcade UI and multilingual support (steps 11 and 12)")
11b. Themes "CRT monitor" and "Arcade front" with a switch, stored like the language
12. Multilingual support (requested on 2026-11-20), German and English, in two parts: 12a the foundation (UI texts per language, choosing the language, push, SDK 0.1.6 with `languages`, `defineTexts` and `cover`, manifest, catalog, `check`, `dev`, templates) before step 11; 12b the four games bilingual with cover images after step 11b
13. Docs in English (requested on 2026-11-20): all docs of the platform and the games become English, i.e. the READMEs, `docs/design.md`, `AGENTS.md` and templates, the game repos and the catalog, plus everything else that developers, agents and operators read; the templates with their examples and the German routes become English as well (see "Docs in English (step 13)"). npm and opening up the platform remain separate decisions.

**Game 5** (decided, built and, with the maintainer's OK, published on 2026-11-24, see "Draw and guess (steps 14 and 14b)"; `hearthbit/gamehearth-kritzelkiste` with release v0.1.0 and in the catalog):

14. Free inputs as placeholders in `legalMoves`, delta frames in realtime, an optional TV, the on-screen keyboard, docs and templates, test game in `fixtures/`
14b. Kritzelkiste (game 5, draw and guess) by an agent with no prior knowledge from the template `realtime`, review and a whole match with three phones via Playwright

**Game nights** (decided on 2026-11-24, see "Bots, playing on and sound (steps 15 and 15b)"):

15. Platform: bots from the game function `bot`, playing on without seats that are away, sound through the platform, SDK 0.1.8 and dev tool 0.10.0, `check`, `dev`, templates, test game in `fixtures/`
15b. Mau-Mau, Farbfelder and Angelteich get a bot and sound, Mauerbrecher gets sound; releases only after the maintainer's OK

Both built, reviewed and released on 2026-11-24.

**Publication** (decided on 2026-11-25, see "Publication (step 16)"):

16. SDK and dev tool on npm, the games and the catalog in fresh repos with npm and a patch version each, the starter repo, the platform repo public, the website on GitHub Pages; done on 2026-11-25

**Game 6** (decided on 2026-11-25, see "Shadow Stage and music (steps 17 and 17b)"):

17. Music loops through the platform: `game.music` in SDK 0.1.9, playback and a music switch in the client and on the TV, `dev` 0.11.0, docs and templates, test game in `fixtures/`
17b. Schattenbühne / Shadow Stage (game 6, roguelike deckbuilder) in five stages, each by a fresh agent with no prior knowledge on the public path and each with its own review

## Deliberately deferred

- isolated-vm instead of QuickJS, if realtime games need more compute time
- public community registry, package signatures, moderation
- own app with a server list (Tauri/Capacitor)
- OIDC login
- prediction with rollback in realtime
- migrating running rooms to new game versions
- `playerView` for special cases of hidden information
- joining running matches freely (manifest field; not even with the party game, because rounds are short and you join in the lobby between rounds; confirmed for game 5 and again before step 15 on 2026-11-24, also not by taking over a bot's seat)
- AI construction kit in the platform
- cryptographically secure randomness (e.g. ChaCha20), if matches with stakes or public servers come along
- checking JSON rules already at the type level; so far only the runtime detects violations
- shared, persistent game worlds across all players (auction house, shared map); deliberately not a goal, profiles stay per player
- passkeys as a second way to log in, self-registration, deleting your own account, sending mail
- untrusted catalogs (with the community registry), uploading packages without a catalog, other people's games in the Gamehearth catalog
- undoing a move in `dev`; docs in English have been planned as step 13 since 2026-11-20
- guests in single-player games, a browser smoke test in `check` for games without a reducer, testing offline play in Firefox
- a tick rate per game instead of a fixed 20 Hz, replay in `dev` for realtime
- sound files in games (only synthesized sounds since step 15, synthesized music loops since step 17), sound that ignores the iPhone's silent switch, a volume control
- leaderboards per period (for example a daily leaderboard; game 6 compares its daily performance at the table, decided on 2026-11-25)
- items, counters and flags for single-player games without a reducer, options for single-player games without a reducer, number ranges as options, leaderboards split by options
- restructuring `docs/design.md` into a reference of the current state and a decision log, for instance when the platform repo becomes public

## Still open

Nothing is open at the moment. Points that were open earlier, and where they were decided:

Decided on 2026-11-25 (see "Publication (step 16)"): when and how the platform repo becomes public, and the website for it.

Decided on 2026-11-17 (see "Accounts and guests"): limits per room and server, backup of the SQLite database.

## Glossary (German → English)

Added in step 13. The glossary keeps one English word per concept in docs, code and commits. Names of our own games (Mau-Mau, Farbfelder, Mauerbrecher, Angelteich) and fixtures stay German, like their IDs.

| German | English |
|---|---|
| Spieleplattform, Plattform | game platform, platform |
| Spielfassung, Fassung (`id@version+hash12`) | build; a blocked build is quarantined |
| Spielpaket | game package |
| Katalog | catalog |
| Vorlage | template |
| Dev-Tool, Werkzeug | dev tool (npm package `gamehearth`) |
| Starter-Repo, Abzug | starter repo, snapshot |
| Raum, Raumcode | room, room code |
| Gastgeber | host |
| Mitglied | member |
| Sitz | seat |
| Partie | match |
| Runde | round |
| Zug, erlaubte Züge | move, legal moves |
| Eingabe | input |
| Zustand | state |
| Stand (an den Client) | snapshot, update |
| Verlauf | history |
| Vorfall | incident |
| Spielstand | save |
| Bestwert | best score |
| Bestenliste | leaderboard |
| Profil, Wegwerf-Profil | profile, throwaway profile |
| Zähler | counter |
| Löschzähler | deletion counter |
| Abgleich | sync |
| Vorladen | preload |
| Gerät | device |
| Gast | guest |
| Sitzung | session |
| Benutzername, Anzeigename | username, display name |
| Einladung | invite |
| Zurücksetz-Link, Einrichtungslink | reset link, setup link |
| Übergabe-Code | transfer code |
| Sperren, Entsperren (Account) | lock, unlock |
| Verwaltung, Admin-Ansicht | admin view |
| Spielseite | game page |
| Spielauswahl | game list |
| Startseite | home page |
| Fernseher | TV (role `screen`) |
| koppeln, Kopplung | pair, pairing |
| Handy | phone |
| Steuerkreuz | d-pad |
| Takt | tick rate |
| Glätten | smoothing |
| Gnadenfrist | grace period |
| Drosselung | rate limiting |
| Leck | leak |
| Probepartie | trial match |
| Prüfsumme | checksum |
| Betreiber, Selfhoster | operator, self-hoster |
| Heimnetz | home network |
| Reducer-Vertrag | reducer contract |
| Hausregeln | house rules |
| Fänger | catcher |
| Person ohne Programmierkenntnisse | a person who doesn't program |
| Agent ohne Vorwissen | agent with no prior knowledge |
| Abnahme | acceptance run |
| Gegenprobe | counter-check |
| Oberfläche | UI |
| Rahmen (in `dev`) | frame |
| Gastgeber-Seite (`dev`) | host page |
| Spielerzahl | player count |
| anmelden, abmelden, Anmeldung | log in, log out, login |
| Fremde (außerhalb des eigenen Kreises) | outsiders |
| Endlosschleife | infinite loop |
| Figur (im Spiel) | character |
| Feld (Spielfeld) | field |
| fälschbar | can be faked |
| Verworfen | rejected |
| Nachgeschärft nach dem Review | tightened after the review |
| Beim Bauen festgelegt | settled while building |
| Bewusst verschoben | deliberately deferred |
| Spielhalle, Automat | arcade, arcade cabinet |
| Titelbild | cover image (`cover`) |
| Neonhalle, Röhrenbildschirm, Automatenfront | Neon hall, CRT monitor, Arcade front (themes) |
| Effekte (Schalter) | effects (switch) |
| Sprache, Sprachwahl | language, choosing the language |
| Übersetzung, übersetzt | translation, translated |
| Reiter (Verwaltung) | tab |
| Zeichnen und Raten | draw and guess |
| Zeichner, Rater | drawer, guesser |
| Begriff | word |
| Tipp, Rateversuch | guess |
| knapp daneben | close (guess) |
| Hinweis (aufgedeckte Buchstaben) | hint |
| Platzhalter (in `legalMoves`) | placeholder |
| freie Eingabe | free input |
| Änderungs-Frame | delta frame |
| Bildschirmtastatur | on-screen keyboard |
| Bot, Sitz abgeben, zurücknehmen | bot, hand over a seat, take it back |
| abwesend, weiterspielen | away, play on |
| Ton, Klang, Stummschalter | sound, sound (a single one), silent switch |
| Musik, Musikschleife, Musik-Schalter | music, track (a loop), music switch |
| Tageslauf, Tagesvorstellung | daily run, daily performance (game 6) |

Renamed in step 13: templates `rundenbasiert`, `echtzeit`, `einzelspieler` → `turn-based`, `realtime`, `single` (old names still work in `new`); examples Kartenduell, Fangen, Pilzsuche → Card Duel, Tag, Mushroom Hunt; starter "Mein Spiel" → "My Game"; routes `/konto`, `/koppeln`, `/spiel/<id>`, `/spielen/<id>` → `/account`, `/pair`, `/game/<id>`, `/play/<id>`.
