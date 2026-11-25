# Mau-Mau

The first Gamehearth game and the first end-to-end slice through the platform. Turn-based, 2–6 players, everyone on their own device.

**This is a frozen test copy.** Since step 7 Mau-Mau lives in its own repo [hearthbit/gamehearth-mau-mau](https://github.com/hearthbit/gamehearth-mau-mau) and comes to the server via a catalog. This copy stays in the monorepo because server, `check` and browser tests run with a real game; it changes only when tests need it. New rules, graphics and bug fixes belong in its own repo.

## Rules

**Cards:** 32 cards, suits clubs (Kreuz), spades (Pik), hearts (Herz) and diamonds (Karo), values 7, 8, 9, 10, jack (Bube), queen (Dame), king (König), ace (Ass).

**Dealing:** Everyone gets 5 cards. One card lies face up as the discard pile, the rest forms the face-down draw pile. The face-up start card has no special effect. Player 1 starts, then it goes in turn.

**Following:** You play a card of the same suit or the same value on the discard pile.

**Drawing:** Whoever cannot follow draws a card. If it fits, you may play it at once; otherwise it is the next player's turn. If the draw pile is empty, the discard pile except the top card is reshuffled.

**Special cards:**

| Card | Effect |
|---|---|
| 7 | The next player draws 2 cards. Instead, they can play a 7 themselves; then the following player draws 4, and so on. Whoever draws the penalty cards may play nothing more in this move. |
| 8 | The next player is skipped. With two players it is your turn again right away. |
| Jack | May go on any card except a jack. Whoever plays it wishes for a suit; the next player must play that suit or draw. |
| Ace | Whoever plays an ace goes again at once and must add a matching card: same suit, another ace or a jack. If they cannot, they draw a card; if it fits, they may play it at once, otherwise it is the next player's turn. |

**End:** Whoever has no cards left first wins, and the match ends at once. This also holds when the last card is a special card. If in turn everyone can neither play nor draw because there is no draw pile left, the match ends too; then whoever has the fewest cards wins.

**Without:** calling "Mau" and "Mau-Mau".

## State

| Area | Content |
|---|---|
| `public` | discard pile, whose turn it is (`current`), phase (`play` or `drawn`), wished suit, open penalty cards from 7s, hand sizes, size of the draw pile |
| `players[seat]` | own hand, card just drawn |
| `secret` | draw pile |

After drawing, the public phase is always `drawn`, whether or not the drawn card fits. So the display does not reveal whether someone could play.

## Moves

| Move | when |
|---|---|
| `{ type: "play", card: "herz-7" }` | play a card |
| `{ type: "play", card: "pik-B", wish: "karo" }` | play a jack and wish for a suit |
| `{ type: "draw" }` | draw when nothing fits (also after an ace), or take the penalty cards of a 7 |
| `{ type: "pass" }` | do not play the card just drawn |

Cards are named `farbe-wert` (suit-value), for example `kreuz-10`, `herz-B` (jack), `pik-D` (queen), `karo-K` (king), `herz-A` (ace).

## UI

The client is in `client/` and is built with Phaser 4, Vite and TypeScript, the recommended starter stack for Gamehearth games. `npm run build` in the monorepo builds it into `dist/client`; the manifest names this folder (`"client": "dist/client"`).

| File | Content |
|---|---|
| `client/src/main.ts` | connects to the platform via `@gamehearth/sdk/client` and starts Phaser |
| `client/src/table.ts` | the table as a Phaser scene: other players at the top, draw pile and discard pile in the middle, your own hand at the bottom, buttons for drawing and keeping, choice of the wished suit for the jack |
| `client/src/art.ts` | draws cards, card back, suit symbols and felt onto canvas textures at start; no image files, all CC0 |
| `client/src/view.ts` | everything the UI decides, without Phaser: card names, sorting, playable cards, status line, layout of the hand; tested in `test/view.test.ts` |
| `client/src/access.ts` | an invisible list of the legal moves as buttons and a description of the table for screen readers and keyboard; the browser tests play through it |

Controls: playable cards sit a bit higher, the others are dimmed while it is your turn. Tapping plays the card; for the jack the game asks for the wished suit. Drawing works via the button or the draw pile. The UI shows only what is in your own snapshot; it does not know which cards others hold.

On high-resolution displays the scene computes in device pixels (Phaser with `zoom: 1 / devicePixelRatio`), so cards and text stay sharp.
