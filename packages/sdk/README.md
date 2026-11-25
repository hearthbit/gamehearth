# @gamehearth/sdk

The SDK describes how a Gamehearth game is built and runs matches. A multiplayer game consists of four pure functions, a realtime game of five (plus `tick`, see "Realtime"). Everything else (seats, checking moves, randomness, catching errors, visibility) is handled by the platform.

The dev tool creates a new game from a template: `npx gamehearth new my-game` (see [gamehearth](https://www.npmjs.com/package/gamehearth)). There you try it out with `npm run dev` and check it with `npm run check`.

## A game in one file

```ts
import { defineGame, type GameState, type PlayerId } from "@gamehearth/sdk";

type Public = { revealed: Record<PlayerId, number> };
type PerPlayer = { card: number };
type Secret = { deck: number[] };
type Action = { type: "reveal" };

export default defineGame<GameState<Public, PerPlayer, Secret>, Action>({
  setup({ players, random }) {
    const deck = random.shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const hands: Record<PlayerId, PerPlayer> = {};
    for (const player of players) {
      hands[player] = { card: deck.pop() ?? 0 };
    }
    return { public: { revealed: {} }, players: hands, secret: { deck } };
  },

  legalMoves(state, player) {
    return Object.hasOwn(state.public.revealed, player) ? [] : [{ type: "reveal" }];
  },

  apply(state, action, { player }) {
    state.public.revealed[player] = state.players[player]!.card;
  },

  result(state) {
    const revealed = Object.entries(state.public.revealed);
    if (revealed.length < Object.keys(state.players).length) {
      return undefined;
    }
    const best = Math.max(...revealed.map(([, card]) => card));
    return { winners: revealed.filter(([, card]) => card === best).map(([player]) => player) };
  },
});
```


Game logic imports only from `@gamehearth/sdk`. It has `defineGame`, the placeholders `text` and `int` with `isPlaceholder` (see "Free inputs: placeholders") and the types, nothing else. The client part of a game in the browser imports from `@gamehearth/sdk/client`. Tools for the server, the dev tool and tests live separately in `@gamehearth/sdk/platform` (see below).

## The state

The state has exactly three areas:

| Area | who sees it | Example |
|---|---|---|
| `public` | all players and the screen | discard pile, points, **whose turn it is** |
| `players[seat]` | only the player in this seat | own hand, secret role |
| `secret` | nobody, only the server | order of the deck |

The platform filters automatically. A game never has to decide itself who may see what; it only has to put the data in the right area. This also applies to whose turn it is: the platform tells nobody which other seats have moves. If the UI should show "Anna's turn", that belongs in `public`.

Rules for the state:

- It contains only JSON values: objects, arrays, strings, finite numbers, `true`/`false`, `null`. No `Set`, no `Map`, no `Date`, no classes, no functions, no getters. For sets use an array or an object with `true` values, for points in time a number.
- Fields with the value `undefined` disappear when saving; that acts like a missing field. In arrays `undefined` is not allowed, use `null` there. Arrays have only elements, no extra properties.
- At most 100 levels of nesting. Store histories as a list, not as a chain `{ prev: { prev: … } }`.
- There are no other fields besides `public`, `players` and `secret`.
- `players` has exactly one entry per seat, no more and no less.

Objects in the state have no prototype. So keys like `constructor` or `toString` are ordinary data, for example in a word game. To check whether a key exists, use `Object.hasOwn(object, key)` or `key in object`, not `object.hasOwnProperty(...)`.

## Seats

In the game, players are called `p1`, `p2`, `p3` … in a fixed order. These are seats, not people. Which person, guest or bot currently sits in a seat is up to the platform. Names therefore don't belong in the state. The order in `ctx.players` works as the turn order.

How many seats there are is stated in the game's manifest (`players.min`, `players.max`, `players.counts`). The platform starts a match only with an allowed number; `setup` does not have to check this.

## The four functions

All four are ordinary, synchronous functions. The platform reports `async` or a returned Promise as an error.

### `setup({ players, random, options, profiles })`

Builds the initial state. `players` is the list of seats, `options` are the game options of the match (see "Game options"), `profiles` the profiles of all seats (see "Profiles").

### `legalMoves(state, player, ctx)`

Returns all moves this seat may make right now, as an array. An empty array means: this seat cannot move right now. `ctx` contains `players`, `options` and `profiles`; if you don't need it, leave out the third parameter.

- Several seats may have moves at the same time, for example when everyone picks a card face down at the same time.
- A move is a JSON value, usually `{ type: "...", ... }`. A move may be at most 16,384 characters long and 32 levels deep.
- **A move may only contain what this player may see.** The moves go to their client. `{ type: "draw" }` is right, `{ type: "draw", card: "hearts-7" }` would reveal the top card of the deck.
- A move that cannot be listed, such as a typed text or a position, contains a placeholder instead of a fixed value (see "Free inputs: placeholders").
- The state is read-only here. Trying to change it causes an error.

### `apply(state, action, ctx)`

Applies a move. The platform calls `apply` **only with moves that were listed in `legalMoves` before**. So `apply` does not have to check whether a move is allowed.

`apply` may change the given state directly and return nothing, or return a new state. Both are fine. Earlier states are always protected.

`ctx` contains:

| Field | Content |
|---|---|
| `ctx.player` | the seat making the move |
| `ctx.players` | all seats |
| `ctx.random` | randomness, see below |
| `ctx.options` | the game options of the match |
| `ctx.now` | time of the move in milliseconds |
| `ctx.away` | seats that are away right now; always empty except in realtime games with `"away": "play-on"` (see "Playing on without seats that are away") |
| `ctx.profiles` | the current profiles of all seats, read-only (see "Profiles") |
| `ctx.profile` | changes profiles: `add`, `use`, `stat`, `record`, `flag` (see "Profiles") |

### `result(state)`

Returns `undefined` while the match is running and `{ winners: [...] }` as soon as it is over. `winners` contains seats. A draw is several winners, a co-op game lost together is `{ winners: [] }`. The state is read-only here.

When nobody has moves left, `result` must return a result. Otherwise the match would hang forever, and the platform reports an error. This does not apply to realtime games, because the ticks carry the match on.

`result` gets no `ctx`. If the end depends on an option, such as the number of rounds, `setup` writes the value into the state.

## Free inputs: placeholders

Some moves cannot be listed one by one: a typed guess, the points of a stroke, a cell on a board with thousands of cells. For those, a move in `legalMoves` contains a placeholder instead of a fixed value (from `"sdk": "^0.1.7"`):

```ts
import { defineGame, int, text } from "@gamehearth/sdk";

const pointChars = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_";

export default defineGame<State, Action>({
  // …
  legalMoves(state, player) {
    if (state.public.drawer === player) {
      return [
        { type: "stroke", color: int({ min: 0, max: 9 }), points: text({ max: 2000, chars: pointChars }) },
        { type: "clear" },
      ];
    }
    return [{ type: "guess", text: text({ min: 1, max: 40 }) }];
  },
  apply(state, action, { player }) {
    if (action.type === "guess") {
      // action.text is what the player typed: 1 to 40 characters
    }
  },
});
```

| Placeholder | allows |
|---|---|
| `text({ max, min?, chars? })` | a text of `min` (default 0) to `max` characters (`max` at most 8,000); with `chars` only those characters, without `chars` every character except control characters and line breaks |
| `int({ min, max })` | a whole number from `min` to `max` |

- The platform compares a move with the placeholders without running game code: the same fields, fixed values equal, every placeholder filled with a value that fits. `apply` gets the concrete move. Characters count as Unicode code points: most emoji are one, a flag or an emoji with a skin tone two, a family emoji five. Texts arrive normalized to NFC (an "ä" is always one character, however the keyboard typed it); `chars` therefore must not contain characters that NFC changes.
- A whole move may be at most 16,384 characters long, and a text character can take two of them. `legalMoves` reports an error in the game code if a move with placeholders could become longer than that when filled; a typed move that NFC makes too long is rejected like any illegal move.
- The game frame is sandboxed without `allow-forms`: a `<form>` never fires `submit` there. A UI for typing listens to the click of its button and to Enter (`keydown` with `event.key === "Enter"`, not while `event.isComposing`) itself.
- Placeholders are typed as `string` and `number`, so that `legalMoves` keeps its type `Action[]`. At runtime they are objects like `{ $text: { min: 1, max: 40 } }`, and the client finds them as such in `snapshot.moves`. The client finds out what it may send by the `type` of a move; `isPlaceholder(value)` from `@gamehearth/sdk/client` recognizes a placeholder, for example to set the `maxLength` of an input field from `value.$text.max`.
- `apply` must cope with every value a placeholder allows. Bots in `check` and `dev` and the server's trial match fill placeholders with random values: texts of every length from `min` to `max` with letters, digits, umlauts, emoji, punctuation and spaces (or only the characters from `chars`), numbers often at the edges. `check` reports where `apply` crashes on them.
- Typed texts are not secret, but whoever reads them is decided as always by the state. A text that only some players may read (for example a chat among those who have already guessed the word) belongs into their areas `players[seat]`. `check` does not report a text that a bot typed when it is copied into several players' areas or into `secret`, because it cannot know who may read it; the game's own tests have to make sure that, for example, a chat among those who have guessed reaches nobody else. A typed text that is in `public` and at the same time in `secret` or in a player's area is still reported, and so is a hidden value that only sits next to a typed text in the same small object.
- `check` reports placeholders in a game whose manifest asks for less than `"sdk": "^0.1.7"`; older servers do not know them.
- Tests call `applyMove` with the concrete move, e.g. `{ type: "guess", text: "Leuchtturm" }`.

## Game options

House rules and variants are listed in the manifest under `options` (from `"sdk": "^0.1.3"`). There are two kinds: yes/no and a choice of fixed values, texts or integers, each with a display name.

```json
"options": {
  "stackSevens": { "label": "Stack 7s", "type": "boolean", "default": true },
  "rounds": {
    "label": "Rounds",
    "type": "choice",
    "default": 5,
    "choices": [
      { "value": 3, "label": "3 rounds" },
      { "value": 5, "label": "5 rounds" },
      { "value": 7, "label": "7 rounds" }
    ]
  }
}
```

The host sets them in the lobby, everyone sees the choice. The game reads them as `ctx.options` in `setup`, `legalMoves`, `apply` and `tick`, always complete: whatever nobody chose is at `default`. The options belong to the match and never change during it; they are read-only. You pass the type to `defineGame` as the third type parameter:

```ts
interface Options {
  stackSevens: boolean;
  rounds: 3 | 5 | 7;
}

export default defineGame<State, Action, Options>({
  setup({ players, options }) {
    return { public: { round: 1, lastRound: options.rounds }, /* … */ };
  },
  legalMoves(state, player, { options }) {
    return options.stackSevens ? stackingMoves(state, player) : simpleMoves(state, player);
  },
  // …
});
```

Rules:

- Names start with a lowercase letter and consist of letters and digits (`stackSevens`, not `stack-sevens`), at most 12 options, a choice has 2 to 20 values of the same type.
- Options don't change the allowed player counts.
- `check` plays every value of every option at least once per player count, with the other options at their default.
- Single-player games without a reducer (`server: false`) have no options; they build their own menu.
- Tests that call `legalMoves` directly pass `ctx` themselves, e.g. `game.legalMoves(state, "p1", { players: ["p1", "p2"], options: { stackSevens: true, rounds: 5 } })`.

## Profiles

Every account has one profile per game, managed by the platform (from `"sdk": "^0.1.4"`). It has three fixed areas:

| Area | Content | Example |
|---|---|---|
| `items` | ID → count (integer of at least 1) | `{ "bait-worm": 3, "good-rod": 1 }` |
| `stats` | name → number | `{ "wins": 14, "biggest-fish": 83 }` |
| `flags` | name → `true` or text | `{ "book-pike": true, "title": "Master Angler" }` |

Profiles survive matches, rooms and game versions. Games have no database of their own; everything persistent lives here. The platform's game page shows your own profile with the display names from the catalog; a flag with `true` appears there as "yes" ("ja"), a text as it is (for example "87 cm").

**The catalog lives in the manifest.** Every ID a game ever writes is listed with a display name in `manifest.json`:

```json
"items": {
  "bait-worm": { "label": "Worm" },
  "old-rod": { "label": "Old rod", "deprecated": true }
},
"stats": {
  "wins": { "label": "Wins", "better": "higher" },
  "fish": { "label": "Fish caught" },
  "best-time": { "label": "Best time", "better": "lower", "format": "time" }
},
"flags": {
  "book-pike": { "label": "Pike in the collection book" }
}
```

- Names consist of lowercase letters, digits and `-`, start with a letter and have at most 40 characters; display names 1 to 40 characters.
- A stat with `better` (`higher` or `lower`) gets a leaderboard on the platform's game page (top 10 of the server's accounts); without `better` it is a counter without a leaderboard. `format` is `number` (default) or `time` (milliseconds, shown as `1:23,4`).
- At most 1,000 items, 200 stats and 200 flags; flag texts up to 200 characters.
- **IDs are forever.** Once published, an ID may never disappear or change its meaning, because it lives on in profiles. What is no longer needed stays with `"deprecated": true`. For this, `check` keeps the file `ids.lock` (see the dev tool's README).

**Reading: `ctx.profiles`.** In `setup`, `legalMoves`, `apply` and `tick` the current profiles of all seats are at `ctx.profiles[seat]`, read-only. Empty entries are missing: `ctx.profiles[seat].items["bait-worm"] ?? 0`. The game always sees the current profile, not the one from the start of the match; if another match of the same player changes their profile, the server recomputes the legal moves. In `apply` and `tick`, `ctx.profiles` shows changes made in the same call right away.

**`legalMoves` only offers what the profile allows.** To drink a potion, you need one:

```ts
legalMoves(state, player, { profiles }) {
  const moves: Action[] = [{ type: "wait" }];
  if ((profiles[player]?.items["healing-potion"] ?? 0) > 0) {
    moves.push({ type: "drink" });
  }
  return moves;
}
```

**Writing: `ctx.profile`.** Only in `apply` and `tick`, never in `setup` or `legalMoves`:

| Call | Effect |
|---|---|
| `ctx.profile.add(seat, item, n)` | adds `n` pieces (integer of at least 1) |
| `ctx.profile.use(seat, item, n)` | consumes `n` pieces; only in `apply` |
| `ctx.profile.stat(seat, name, n)` | changes a counter by `n` (also negative or with decimals), works on any stat |
| `ctx.profile.record(seat, name, value)` | best score: keeps the better value according to `better` in the manifest; only stats with `better` |
| `ctx.profile.flag(seat, name, value)` | sets a flag (`true` or text), `false` deletes it |

```ts
apply(state, action, ctx) {
  if (action.type === "cast") {
    ctx.profile.use(ctx.player, "bait-worm", 1);
    const caught = ctx.random.weighted(fishTable);
    ctx.profile.stat(ctx.player, "fish", 1);
    ctx.profile.record(ctx.player, "biggest-fish", caught.size);
    ctx.profile.flag(ctx.player, caught.book, true);
  }
}
```

- A move and its profile changes apply together or not at all. The server applies the changes atomically to the current profile; two matches of the same player never lose each other's changes.
- **If an item that `use` consumes is missing**, for example because another match just consumed it, the platform rejects the whole move with the code `missing-item`, and the state stays as it was. This also holds if the game catches the error with `try`/`catch`. In realtime only this input is dropped.
- **An ID that is not in the manifest** is an error in the game code (`game-error` with the location in the source and a suggestion for typos), as is a wrong value or a seat that is not in the match.
- `use` does not exist in `tick`: the server cannot reject a tick without pausing the match. Consuming belongs in the move that triggers it.
- Only changes with an effect count: a `record` that does not improve the best score, a `stat` by 0 or a flag that is already set that way changes nothing and goes nowhere. Every real change in `tick`, on the other hand, costs the server a write transaction and sends everyone the whole room; counters that would grow in every tick are better collected in the state and written once at the end of the match.
- **Guests** have an empty throwaway profile per match. The game works with it as usual and does not need to know about guests; at the end of the match it is gone.
- The profiles of all seats are readable for the game logic. What other players see of them is, as always, decided by the state; the client gets only its own profile.

**ID types from the manifest.** With `resolveJsonModule` the game imports its manifest and gets the IDs as types; a typo, even in a rare drop of a data table, becomes a type error:

```ts
import { defineGame, type CatalogOf } from "@gamehearth/sdk";
import manifest from "../manifest.json";

type Ids = CatalogOf<typeof manifest>;
type ItemId = Ids["items"];

const shop: { item: ItemId; price: number }[] = [{ item: "bait-worm", price: 2 }];

export default defineGame<State, Action, Options, Ids>({ /* … */ });
```

`CatalogOf` returns `items`, `stats`, `flags` and `ranked` (stats with `better`, the only ones `record` accepts). Without the fourth type parameter all IDs are just `string`. Tests that call `legalMoves` directly pass the profiles themselves, e.g. `{ players: ["p1"], options: {}, profiles: { p1: { items: { potion: 1 }, stats: {}, flags: {} } } }`.

## Realtime

A realtime game (`"mode": "realtime"` in the manifest, `"sdk": "^0.1.1"` or newer) has a fifth function:

### `tick(state, dt, ctx)`

Advances the world by one step, for example moving characters, counting down time, awarding points. The platform calls `tick` at a fixed tick rate: 20 times per second, `dt` is always 50 (milliseconds). `ctx` contains `players`, `random`, `options`, `now`, `away` (see "Playing on without seats that are away"), `profiles` and `profile` (without `use`, see "Profiles"). Like `apply`, `tick` may change the state directly or return a new one.

```ts
export default defineGame<State, Action>({
  setup({ players }) { /* … */ },
  legalMoves(state, player) {
    return [{ type: "steer", dir: "left" }, { type: "steer", dir: "right" }, { type: "steer", dir: "none" }];
  },
  apply(state, action, { player }) {
    state.public.steer[player] = action.dir;
  },
  tick(state, dt) {
    state.public.timeLeft -= dt;
    // move characters according to state.public.steer …
  },
  result(state) {
    return state.public.timeLeft <= 0 ? { winners: leaders(state) } : undefined;
  },
});
```

This is how a tick runs:

1. All inputs that arrived since the last tick go through `apply` one by one in the order they arrived, each against the `legalMoves` valid at that point. Inputs are ordinary moves.
2. Then `tick` computes one step.
3. After every move and after the tick, `result` checks whether the match is over. If an input ends it, no tick runs in this step.

Rules for realtime games:

- **Inputs describe what is currently pressed**, not every key press. `{ type: "steer", dir: "left" }` on press and `{ type: "steer", dir: "none" }` on release; `tick` then moves as long as someone steers. Send only when something changes, not on every movement of the finger: the platform accepts at most 30 inputs per second per member (above that `rate-limited`), and at most 4 wait for the next tick per seat; if a fifth arrives, the oldest is dropped and its `move` answers `too-many-inputs`.
- **Inputs that must not get lost**, such as the points of a stroke, are collected by the client and sent as one input at most every 50 to 100 ms. Make them repeatable (each carries its position, so that `apply` ignores what the state already has) and let the client compare its own copy with the state and send again what is missing. An error answer alone is not enough: during a pause only the last input per seat survives, and `move` answers `{ ok: true }`. Growing data like a drawing belongs in the state as a text or list that only grows at the end: the platform then sends devices only the appended part.
- **During a pause** the platform remembers the last input per seat and applies it in the first tick afterwards; `move` then answers right away with `{ ok: true }`. A release during the pause is not lost that way. Inputs during the countdown also apply to the first tick.
- **Count time in ticks.** For time limits and cooldowns, sum up `dt` or count ticks, not `ctx.now`. `now` is the server's clock time and keeps running during a pause.
- **Every match needs an end**, usually a time limit. `check` reports matches that don't end after 10 minutes of play time as an error.
- **Keep the state small.** A tick checks, clones and freezes the whole state, 20 times per second. Store a grid as text or a list of numbers rather than as thousands of objects. `check` warns when a tick in QuickJS takes longer than 10 ms on average.
- `legalMoves` may be empty for everyone in some phases (for example during a countdown in the game); the match keeps running anyway.

What the platform does for this: it collects the inputs until the next tick, then sends every device its snapshot, pauses the match while a seat or a TV that is not optional is missing, counts down 3 seconds after a pause and saves the match every 10 seconds. An error in `tick` pauses the match at the last valid state. A game doesn't need to know about any of this.

### Playing on without seats that are away

Normally a realtime match pauses as soon as a seat has had no visible phone for 2 seconds (locked, app in the background, out of the Wi-Fi). That is right for action games: whoever locks their phone would otherwise lose. A game whose rules can carry on without someone, such as a party game with turns, declares in the manifest (`"sdk": "^0.1.8"`):

```json
"mode": "realtime",
"away": "play-on"
```

Then the match does not pause for a missing seat; instead the seat counts as away, and `ctx.away` in `apply`, `tick` and `bot` lists the away seats (sorted like `ctx.players`). Whoever comes back is present again in the next tick, without a countdown. The game decides what away means, for example skipping an absent drawer, or ending a turn as soon as everyone present has guessed:

```ts
tick(state, dt, { players, away }) {
  const present = players.filter((seat) => !away.includes(seat));
  if (present.every((seat) => state.public.guessed.includes(seat))) {
    endTurn(state);
  }
}
```

- `legalMoves` gets no `away`. If moves depend on it, `tick` writes what is needed into the state (for example `state.public.away`).
- The match still pauses when every seat played by a person is away, and when a TV that is not optional is missing.
- Bots (see "Bots") never count as away.
- `check` lets seats go away and come back during its matches, so a game that never expected it crashes there and not at a game night.
- Without `"away": "play-on"`, `ctx.away` is always empty.

## Bots

A game may export a sixth, optional function. Only games with it offer bots: the host fills up the lobby with bots, and a seat whose person has to go is handed over to a bot.

### `bot(state, player, moves, ctx)`

Picks one of the seat's legal moves. `moves` is the same list `legalMoves` returned for this seat (never empty), `ctx` contains `players`, `random`, `options`, `now`, `away` and `profiles`.

```ts
bot(state, player, moves, { random }) {
  const plays = moves.filter((move) => move.type === "play");
  return plays.length > 0 ? random.pick(plays) : moves[0];
}
```

- Return one of `moves`. A move with placeholders is returned filled, for example `{ type: "guess", text: "house" }`; the platform checks it like any other move.
- `undefined` leaves the choice to the platform: in turn-based games it takes a random legal move, in realtime the bot sends no input in this tick. A realtime bot is asked in every tick (20 times per second): return a move only when something changes, like a person who presses or releases.
- `bot` is pure like the rest: the state, the moves and the profiles are read-only, there is no `ctx.profile`, and randomness comes only from `ctx.random`. That generator is the bot's own (derived from the match), so the bot never changes the match's randomness, and the same situation gives the same choice.
- If `bot` throws or returns a move that is not legal, the platform takes a random legal move instead (turn-based) or none (realtime) and writes the reason to the log. `check` reports it as an error.
- A bot plays with the profile of its seat: a seat handed over by a person keeps that person's profile, a bot from the lobby has an empty throwaway profile like a guest.
- In the client, `players` marks bots with `bot: true` (for example `{ name: "Robo-Rita 🤖", connected: true, you: false, bot: true }`).
- A simple bot is enough. Bots fill a seat for a family evening; they should play sensibly, not perfectly.

## Randomness and time

Rules that run on the server (everything in `defineGame`) **never** use `Math.random()`, `Date.now()` or `new Date()`. Instead:

| Method | returns |
|---|---|
| `random.next()` | number from 0 to below 1 |
| `random.int(min, max)` | integer from `min` up to and including `max` |
| `random.pick(list)` | one element of the list |
| `random.shuffle(list)` | a shuffled copy, the list itself stays unchanged |
| `random.weighted(table)` | one entry of the table, drawn by its `weight` |

`random.weighted` draws from a table of objects with an integer `weight` of 0 or more (at least one greater than 0, at most 2³² in total) and returns the entry itself, so directly a row of the data table:

```ts
const caught = ctx.random.weighted([
  { id: "perch", weight: 60 },
  { id: "pike", weight: 25 },
  { id: "goldfish", weight: 1 },
]);
```

With integers every engine draws exactly the same, and probabilities read as "1 in 86".

Time comes from `ctx.now`. Only then can every match be replayed exactly from the seed and the moves. The platform needs that for saving, debugging and automated tests.

More rules for the same reason: `legalMoves`, `apply` and `result` depend only on their arguments. No network, no files, no changing variables outside the functions.

## Errors the platform detects

Errors in the game code are caught. The match stays in the last valid state, and the error is reported with the phase (`setup`, `legalMoves`, `apply`, `result`, in realtime `tick`), the affected seat, the reason and, if available, the first lines of the stack trace. Examples:

- `apply threw an error: Cannot read properties of undefined`
- `apply returned an invalid state: state.public.used is a Set, only plain objects, arrays and primitive values are allowed`
- `setup returned an invalid state: state.players has no entry for the seat p3`
- `legalMoves for p1 threw an error: Cannot assign to read only property 'count' of object`
- `apply must not be async or return a Promise`
- `result returned an invalid result: winners contains "anna", which is not a seat in this match (seats: p1, p2)`
- `after apply nobody can move, but result reports no end; the match would hang forever`

Infinite loops and memory hogs are caught not by the SDK but by the server's sandbox: every call of game code may take at most 100 ms there and use at most 32 MB of additional memory. The dev tool's `check` finds such spots beforehand and reports where they hang (see the README of the dev tool `gamehearth`, in the game under `node_modules/gamehearth/README.md`).

## Where game code runs

On the server, game code does not run in Node but in QuickJS, a small JavaScript engine in a sandbox. For games this means:

- There is only the language itself: no `console`, no `structuredClone`, no `Intl`, no `TextEncoder`, no `atob`, no `URL`, no timers, no network, no files. `Math.random`, `Date.now`, `new Date()` without an argument, `eval` and the `Function` constructor throw an error.
- Dates only in UTC: `new Date(number)`, `Date.UTC(...)` and the methods with `UTC` in their name. Everything that depends on the machine's time zone (`getHours`, `toString`, `new Date(2026, 0, 1)`, `new Date("…")`, `Date.parse`) throws an error, also in `check`.
- `Math.sin`, `Math.cos`, `Math.exp`, `Math.log`, `Math.pow`, `Math.hypot`, `Math.tanh` and relatives sometimes compute the last digits differently than in the browser or in Node. On the server every match stays replayable anyway; if you need exactly the same results everywhere, compute with integers or basic arithmetic (`+`, `-`, `*`, `/`, `Math.sqrt`, `Math.floor`).
- `localeCompare` and `toLocaleString` know no locale; "Äpfel" sorts after "Zebra" there. To sort text, write your own comparator.
- A comparator for `sort` must consistently return negative, 0 or positive; `(a, b) => a > b` gives a different order in every engine.
- Every move checks, clones and freezes the whole state. Several tens of thousands of small objects in the state blow the time limit; long texts are cheap. The output of a move may be at most 256 KB (in UTF-8), and state and legal moves together at most 20,000 nodes (every object, every list and every single value counts).

That's why `check` also replays some matches in QuickJS and reports when they run differently there or fail.

`tick` runs in QuickJS like all other functions and must fit within the same limits; at 20 ticks per second, though, a tick including its inputs should stay well below the 100 ms (see "Realtime").

## In the browser: `@gamehearth/sdk/client`

The client part of a game runs in a sealed-off iframe of the platform. It can use neither `fetch` nor WebSocket to the outside and knows neither the server nor a token; everything goes through the platform. Games don't use WebRTC either (the browser doesn't block it, but it is not part of the contract).

```ts
import { connect } from "@gamehearth/sdk/client";
import type { MauMauAction, MauMauState } from "../src/game";

const game = await connect<MauMauState, MauMauAction>();

game.onUpdate(({ snapshot, players, options, profile, online }) => {
  // snapshot: public, me, moves, version, result (see playerSnapshot)
  // players.p1: { name: "Anna", connected: true, you: false }
  // options: the game options of the match, e.g. { stackSevens: true }
  // profile: your own profile, e.g. { items: { coin: 4 }, stats: {}, flags: {} }
  render(snapshot, players, options, profile);
});

const result = await game.move({ type: "play", card: "hearts-7" });
if (!result.ok) {
  // result.code: illegal-move, not-your-turn, stale, game-over, missing-item, offline, timeout …
}
```

| Part | Meaning |
|---|---|
| `connect()` | registers with the platform and waits for the first update (at most 10 seconds); if the game is not running in Gamehearth, the promise is rejected |
| `game.seat` | your own seat, e.g. `"p2"` |
| `game.language` | the language the platform chose for this device, e.g. `"de"` (see "Languages") |
| `game.current` | the most recently received update |
| `game.onUpdate(f)` | calls `f` right away with the current update and then on every change; returns a function to unsubscribe |
| `game.move(action)` | sends a move; the answer is `{ ok: true }` or `{ ok: false, code, message }` and arrives after at most 15 seconds (otherwise `timeout`) |
| `game.sound(sound)`, `game.soundOn`, `game.onSound(f)` | plays a sound through the platform, see "Sound" |

- The new update after a move comes through `onUpdate`, not as the answer of `move`. When `move` answers `{ ok: true }`, it has already arrived; `game.current` then shows the update after the move.
- `move` sends along the `version` of the most recently received update. If the match has changed in the meantime, the answer is `stale`, and the new update is already on its way. A game doesn't need to react to this.
- Names are only available through `players`, never in the state. `connected` says whether someone is currently connected; `online` says whether your own device reaches the server.
- `options` contains the game options of the match, complete with defaults, so the UI can show house rules without copying them into the state. You pass the type as the third type parameter: `connect<State, Action, Options>()`.
- `profile` is your own current profile (`items`, `stats`, `flags`), also after changes from other matches; the client never gets the profiles of other players. Showing coins or an inventory thus needs nothing in the state. You pass the type as the fourth type parameter: `connect<State, Action, Options, Ids>()` (see "Profiles"). A TV gets no profile.
- The platform itself shows lost connections, errors in the game code on the server and rate limiting; it shows `missing-item` as a short notice.
- Whose turn it is lives, as always, in the game's state (`public`).

### Sound

A game plays sounds through the platform; it needs no audio code and no sound files:

```ts
game.sound("coin");
game.sound({ notes: [{ freq: 440, length: 0.08 }, { freq: 660, at: 0.08, length: 0.12, wave: "triangle" }] });
```

- **Named sounds:** `tap`, `blip`, `select`, `move`, `coin`, `hit`, `pop`, `start`, `tick`, `error`, `win`, `lose` (the list is `soundNames`).
- **Own sounds** are up to 16 notes: `freq` in hertz (30 to 8,000), optionally `to` (slides to this pitch), `at` (start in seconds), `length` in seconds (at least 0.01; everything ends within 2 seconds), `wave` (`square`, the default, `sine`, `triangle`, `sawtooth`) and `volume` (0 to 1, default 0.5).
- The platform synthesizes the sound with Web Audio, only when the device's sound switch is on. It is off by default; players turn it on in the menu of the game page. `game.soundOn` says whether it is on, `game.onSound(f)` reports changes. `game.sound` returns `false` when it plays nothing (switch off, or an invalid sound, which it also reports on the console).
- On iPhones the ringer switch also applies: with the phone muted, there is no sound.
- **With a TV:** shared sounds (start, end, a point for someone) come from the TV, personal ones (your turn, your card) from the phone. The TV has its own switch; turning it on also unlocks its sound.
- The platform plays at most 12 sounds per second per game frame and drops the rest. Use sounds for events, not for every tick.
- `connectSolo` offers the same `sound`, `soundOn` and `onSound`.

### Roles: player, controller and TV

Every device has a role (`game.role`) that the platform assigns from the manifest:

| Role | Device | gets |
|---|---|---|
| `player` | everyone on their own device | seat, own snapshot (`me`), own moves |
| `controller` | phone as a controller, the TV shows the field | like `player` |
| `screen` | TV, paired with the room | only public data: `players`, `public`, `version`, `tick`, `result`; no seat, no moves |

A game with a TV (role `screen` in the manifest) calls `connect({ screen: true })` and then branches:

```ts
import { connect, createTimeline, lerp } from "@gamehearth/sdk/client";

const game = await connect<State, Action>({ screen: true });
if (game.role === "screen") {
  // draw the field; game.current.snapshot is a ScreenSnapshot without me and moves
} else {
  // controller: game.seat, game.move(…)
}
```

Without `screen: true`, `connect` rejects the TV role with an error message; turn-based games without a TV need no changes.

A TV can be optional: next to the role `player`, the manifest marks it with `"screen": { "inputs": [], "screen": "large", "optional": true }` (needs `"sdk": "^0.1.7"`). Everyone then plays on their own device; a match starts without a TV, and a missing TV never pauses it. Pairing works as usual, and paired TVs get the role `screen` and show the game. The phones must therefore show everything a player needs; the TV only adds the big picture.

### Smoothing in realtime

The server sends 20 snapshots per second, a screen draws 60 or more frames. `createTimeline` buffers the snapshots with their tick number and returns two snapshots and a blend factor for every frame:

```ts
const timeline = createTimeline(game);

function draw() {
  const frame = timeline.frame();
  if (frame !== undefined) {
    const x = lerp(frame.from.public.x, frame.to.public.x, frame.alpha);
    // draw …
  }
  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);
```

| Part | Meaning |
|---|---|
| `createTimeline(game, { delayMs? })` | listens to `game.onUpdate`; by default shows two ticks (100 ms) behind the newest snapshot, so that there is almost always one snapshot before and one after. If the platform sends a different tick duration (`tickMs` in the update, for example in slow motion in `dev`), the buffer uses it |
| `timeline.frame(now?)` | `{ from, to, alpha }` with `alpha` from 0 to 1, or `undefined` before the first snapshot; if nothing follows (pause, end), `from` and `to` are the newest snapshot |
| `timeline.latest` | the newest snapshot |
| `timeline.dispose()` | unsubscribes again |
| `lerp(a, b, alpha)` | blends two numbers |

Only values that change smoothly are blended, such as positions. Points, counters, indices and everything that jumps come from `frame.to`. If the tick number jumps back (new round), the buffer starts over; after a pause it realigns.

### Single player without a reducer: `connectSolo`

A game with `"mode": "single"` and `"server": false` has no reducer. It runs entirely in the browser, with its own game loop and engine physics, and uses only the save and best scores from the platform. It is played without a room and also offline (from SDK 0.1.2, in the manifest `"sdk": "^0.1.2"`).

```ts
import { connectSolo } from "@gamehearth/sdk/client";

interface SaveGame {
  level: number;
  points: number;
}

const game = await connectSolo<SaveGame, "points">();

const progress: SaveGame = game.saved ?? { level: 1, points: 0 };
// … play …
await game.save({ level: 2, points: 1200 });
await game.record("points", 1200);
const best = game.best.points; // own best score or undefined
```

| Part | Meaning |
|---|---|
| `connectSolo<SaveGame, Stat>()` | registers with the platform and waits for the save and best scores (at most 10 seconds); in a room or outside Gamehearth the promise is rejected with an explanation |
| `game.language` | the language the platform chose for this device (see "Languages") |
| `game.saved` | the most recently stored save or `undefined`; every read returns a separate copy that the game may change |
| `game.save(data)` | stores the save; the promise resolves as soon as it is on the device. It reaches the server later on its own |
| `game.best` | your own best scores, e.g. `{ points: 1200 }`; names without a value are missing |
| `game.record(stat, value)` | reports a value; the platform keeps the better one, and `game.best` then shows the best score |

`save` and `record` are rejected on errors (loudly, with an explanation) instead of failing silently: a save that is not plain JSON, `null` (stands for "no save") or larger than 64 KB, a name that is not listed under `stats` in the manifest, or a value that is not a finite number.

**Best scores in the manifest.** Which best scores exist and whether higher or lower is better is stated only in `manifest.json`; the game only reports values:

```json
"stats": {
  "points": { "label": "Points", "better": "higher" },
  "best-time": { "label": "Best time", "better": "lower", "format": "time" }
}
```

| Field | Meaning |
|---|---|
| Name (`points`) | lowercase letters, digits and `-`, starts with a letter, at most 40 characters, not a name every JavaScript object already has (`constructor`). A name is forever: renaming loses all previous best scores |
| `label` | display name in the platform's leaderboard, 1 to 40 characters, or one per language (see "Languages") |
| `better` | `higher` (bigger is better, e.g. points) or `lower` (smaller is better, e.g. a time) |
| `format` | optional: `number` (default, integer or decimal) or `time` (milliseconds, shown as `1:23,4`) |

At most 10 best scores per game, each with `better`. Best scores are profile stats as in games with a reducer (see "Profiles") and appear on the platform's game page with a leaderboard; the game itself sees only its own. All values come from the device and can therefore be faked; the leaderboard says "reported by the device" ("vom Gerät gemeldet"). Items and flags don't exist yet for single-player games without a reducer; inventory and unlocks belong in the save. Here too names are forever, and `check` keeps them in `ids.lock`.

**Saves across versions.** A save belongs to the game, not to a version: after an update the new version reads the save of the old one. Safest is a save that carries its own number (`{ format: 1, … }`); a game that doesn't understand a save starts over instead of crashing. If a broken save still crashes the game, the person can delete it in the platform's menu.

**Time and randomness.** A single-player game without a reducer runs only in the browser; there it may use `Math.random()`, `Date.now()` and its engine's time. The rules above on `random` and `ctx.now` apply only to code in `defineGame`.

**What the platform does for this.** It saves to the device right away and syncs with the server as soon as it is reachable: for best scores the better one wins, for the save the newer one. Offline it loads the game from the browser cache. The game doesn't need to know about any of this; in particular it needs neither `localStorage` nor `indexedDB` (neither exists in the sealed-off iframe).

**Protocol.** Underneath `connect` is `postMessage` with messages of the form `{ gamehearth: 1, type, … }`. The game sends `ready` and `move` (`id`, `action`, `expectedVersion`), the platform sends `update` (`seat`, `role`, `snapshot`, `players`, `options`, `online`, for seats `profile`, optionally `tickMs` when a tick currently doesn't last 50 ms, optionally `language`) and `result` (`id`, `ok`, on errors `code` and `message`). `role` is `player`, `controller` or `screen`; a TV has `seat: null`. Realtime snapshots carry `snapshot.tick`. Underneath `connectSolo` the game sends `solo-ready`, `save` (`id`, `data`) and `record` (`id`, `stat`, `value`), the platform sends `solo` (`saved`, `best`, optionally `language`; `saved: null` means no save) and `result`. If a game does not match the page that opened it (`connect` on the single-player page, `connectSolo` in a room), the platform answers with `refused` (`message`). Both sides discard messages from other windows and in a foreign shape. For the platform, `parseGameMessage` from `@gamehearth/sdk/platform` checks the shape, size and JSON rules of every move and save like the server does.

## Languages

From SDK 0.1.6 (in the manifest `"sdk": "^0.1.6"`) a game can speak several languages. Every device plays in its own language, also in the same room: the state holds only IDs and numbers, and every client draws its own texts.

**In the manifest**, `languages` lists the game's languages, the default first (codes like `"en"`, `"de"` or `"pt-BR"`, at most 20). `name`, `description` and every `label` (options, choices, `items`, `stats`, `flags`) are either a text that applies to every language or an object with one text per language (the type `Localized`):

```json
"languages": ["de", "en"],
"name": "Mau-Mau",
"description": { "de": "Kartenspiel für 2–6", "en": "Card game for 2–6" },
"stats": { "wins": { "label": { "de": "Siege", "en": "Wins" }, "better": "higher" } }
```

An object needs exactly the languages from `languages`; `check` reports a missing or unknown one as an error, and plain texts in a game with several languages as a warning (fine for a text that is the same in every language, such as a proper name). A game without `languages` works as before; `languages` and `cover` need `"sdk": "^0.1.6"`, so that older servers don't install the game.

**In the client**, `game.language` (from `connect()` and `connectSolo()`) is the language the platform chose for this device: the language set in the platform, then the browser's languages, otherwise the game's default, always one of `languages`. An older platform sends none; then it is the browser's primary language, else `"en"`. The language never changes during a connection; when someone switches it, the platform reloads the game. `defineTexts` keeps the texts per language with type checking:

```ts
import { connect, defineTexts } from "@gamehearth/sdk/client";

const texts = defineTexts({
  de: { yourTurn: "Du bist dran", cards: (n: number) => (n === 1 ? "1 Karte" : `${n} Karten`) },
  en: { yourTurn: "Your turn", cards: (n: number) => (n === 1 ? "1 card" : `${n} cards`) },
});
const game = await connect<State, Action>();
const t = texts(game.language);
t.cards(3); // "3 Karten" on a German device
```

- A key that is missing in one language, or a function with other parameters, is a type error. Values are texts or functions that return a text (for numbers, plurals and names). The type of one block is `ReturnType<typeof texts>`.
- `texts(language)` takes the language itself, then its base language (`de-AT` → `de`), otherwise the first block. Write the blocks in the order of `languages` in the manifest, so that the first block is the game's default language.
- `localize(value, language?)` turns a `Localized` from the manifest into a text: a plain text as it is, from an object the language, then the base language, otherwise the first entry.
- Rules (`defineGame`) produce no texts for players: the `message` of a rejected move is an English text for developers, and the UI shows its own text per `code`.
- Numbers and times follow the language (`1:23.4` in English, `1:23,4` in German); the game formats its own.

## For the platform: `@gamehearth/sdk/platform`

These functions are used by the server, the dev tool and tests, not by the games themselves.

| Function | Purpose |
|---|---|
| `createMatch(game, { playerCount, seed, options?, catalog?, profiles? })` | starts a match; `options` are the already resolved game options (see `resolveOptions`), `catalog` the catalog from the manifest (`items`, `stats`, `flags`; in tests simply the imported `manifest.json`; without `catalog` every ID is unknown and every profile write is an error), `profiles` the profiles per seat (missing ones are empty) |
| `applyMove(game, match, { player, action, now, expectedVersion? }, { catalog?, profiles? })` | applies a move; additionally returns `changes`, the profile changes in order |
| `stepMatch(game, match, { inputs, now, dt, away?, bots? }, { catalog?, profiles? })` | one realtime step: the inputs `{ player, action }` in order, then one move from `bot` for every seat in `bots` (in that order, against the state after the inputs), then `tick`; `away` lists the away seats for `ctx.away`. Returns `{ ok: true, match, results, changes?, bots? }` or `{ ok: false, error }`. `results` has one result per input in the same order, each `{ ok: true }` or `{ ok: false, code, message }`, so without the `error` field as in `applyMove`; `changes` contains only changes from successful inputs, bot moves and the tick; `bots` lists `{ player, message }` for bots whose choice was replaced or refused |
| `botMove(game, match, player, { now, away?, catalog?, profiles? })` | asks `bot` for a move of this seat: `{ ok: true, action?, chosen, problem? }` with `chosen` `"bot"`, `"random"` (no `bot`, `undefined`, or a problem in turn-based) or `"none"` (no move); `problem` says why the bot's choice was replaced. The caller still plays the move with `applyMove`. `hasBot(game)` says whether a game has `bot` |
| `soundProblem`, `readSound`, `soundNotes`, `soundNames` | check a sound from a game, normalize it and turn a named sound into notes; the platform client and `dev` play them |
| `refreshMatch(game, match, { catalog?, profiles? })` | recomputes the legal moves of a turn-based match with new profiles; the state stays, `version` goes up by 1; returns `{ ok: true, match }` or `{ ok: false, error }` like `createMatch` |
| `applyChange(profile, change, catalog)` | applies a profile change `{ op, id, value }` like the runner; returns `undefined` or `{ kind: "missing" \| "invalid", message }` |
| `validateCatalogSpec`, `catalogIds`, `profileProblem`, `changeProblem`, `readProfile`, `emptyProfile` | check and read catalog and profiles, the same rules in SDK, dev tool and server |
| `tickRate`, `tickMs` | the fixed tick rate: 20 ticks per second, 50 ms |
| `playerSnapshot(match, player)` | what a seat's client gets |
| `screenSnapshot(match)` | what a screen (role `screen`) gets |
| `jsonDelta(base, next)`, `applyJsonDelta(base, delta)` | the changes from one JSON value to the next as a list of operations, and applying them; the server and the platform client use them for delta frames in realtime. An operation is `{ op, path, … }` with `path` a list of keys and indices: `set` (`value`), `delete` (a field), `append` (`text` to a text), `push` (`items` to a list) and `truncate` (a list to `length`). `applyJsonDelta` checks the delta, changes nothing in the base (unchanged parts are shared) and returns `{ ok: true, value }` or `{ ok: false, message }` if the delta is malformed or does not fit the base. Keys like `__proto__` and `constructor` are ordinary data on both sides |
| `isPlayerCountAllowed`, `allowedPlayerCounts`, `validatePlayerCountSpec` | player count from the manifest |
| `parseGameMessage`, `parsePlatformMessage` | check messages between the platform and the game iframe (see above) |
| `saveProblem`, `recordProblem`, `maxSaveBytes`, `statNamePattern` | rules for saves and best scores of single-player games, the same in SDK, platform and server |
| `validateOptionsSpec`, `resolveOptions`, `defaultOptions`, `optionValueProblem`, `optionLabel` | check game options from the manifest, fill in defaults (unknown options are dropped, unknown values fall back to the default), check and display a choice |
| `validateLanguages`, `localizedProblem`, `localize`, `pickLanguage`, `primaryLanguage`, `supportsLanguage`, `isLanguage`, `languagePattern` | languages and translated texts from the manifest: check them, pick the language for a device and turn a `Localized` into a text |

**A test with a fixed order.** To test a rule with a particular deck or draw (for example "the next card is a 7"), create the match, change `match.state` (a copy, it is plain JSON) and let `refreshMatch` recompute the legal moves for the changed state, then play on with `applyMove`:

```ts
const created = createMatch(game, { playerCount: 2, seed: "test" });
if (!created.ok) throw new Error(created.error.message);
const match = { ...created.match, state: { ...created.match.state, secret: { deck: ["7-1", "13-1", "2-3"] } } };
const fixed = refreshMatch(game, match);
if (!fixed.ok) throw new Error(fixed.error.message);
```

`createMatch` and `applyMove` return `{ ok: true, match }` or `{ ok: false, error }`. `error` has `code` and `message`, for `game-error` also `phase` and, where known, `player` and `stack`. The codes:

| Code | Meaning |
|---|---|
| `game-over` | the match is already over |
| `unknown-player` | this seat does not exist |
| `stale` | the move refers to an old version (`expectedVersion`) |
| `not-your-turn` | the seat has no moves right now |
| `illegal-move` | the move is not among the legal moves, is not a JSON value or is too large |
| `missing-item` | `ctx.profile.use` did not find enough pieces in the profile; the move is rejected, nothing has changed |
| `game-error` | the game code made an error |

Errors of the platform itself, on the other hand, throw exceptions: an invalid player count, an empty seed, a `now` that is not a finite number, or a match in an unknown format.

A match (`Match`) is plain JSON and can be stored as is. It contains the format version, seed, seats, for games with options the options (`options`), the state, the legal moves per seat, the state of the random generator, a version number, in realtime the number of ticks (`tick`) and, if any, the result. The legal moves are computed once after every change and stored; snapshots therefore run no game code. `version` goes up with every change of the state. A client sends it along as `expectedVersion`, so that a double click or an outdated view does not trigger a wrong move.

A `playerSnapshot` contains `player`, `players`, `public`, `me` (the seat's own area), `moves` (its own moves), `version`, in realtime `tick` and, if any, `result`. `players` here is the list of seats in the same order as `ctx.players` in the rules; the `players` of the same name in a client update, on the other hand, is an object with names per seat. A `screenSnapshot` contains `players`, `public`, `version`, in realtime `tick` and, if any, `result`.

`createMatch` recognizes a realtime game by `tick` and starts with `tick: 0`. A realtime step increases `version` and `tick` by exactly 1, no matter how many inputs it contains. An input that is not allowed gets its error code in `results` without holding up the step; an error in the game code (`game-error`, also phase `tick`) makes the whole step fail.

**Seeds** are generated randomly by the server, at least 128 bits (e.g. 32 hex characters from a cryptographic random generator). Seed and random state never leave the server; the snapshots don't contain them. The random generator (sfc32 with 128 bits of state) is fast and reproducible, but not cryptographically secure. It is too large for trying out all states, but it is not built to withstand targeted cryptanalysis.

## Not included yet

- Prediction with rollback in realtime; smoothing deliberately shows the world about 100 ms behind the server.
- A tick rate per game; all realtime games run at 20 ticks per second.
- Time limits per move.
- Sound files and a volume control; sounds are synthesized from notes.
- Placeholders for decimals, for lists of varying length and for patterns; free inputs go through `text()` and `int()` (see "Free inputs: placeholders").
- Checking the JSON rules while typing (at the type level). So far only the runtime detects violations, but with a precise message.
- Items, counters and flags for single-player games without a reducer; they have a save and best scores.
- Other players' profiles in the client and profile migrations by the game (deliberately not: IDs are forever).
