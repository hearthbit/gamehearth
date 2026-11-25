# Tag

A realtime game for [Gamehearth](https://github.com/hearthbit/gamehearth-starter), the self-hosted game platform. A TV shows the field, the phones are controllers.

## Rules

For 2 to 6 players.

- Everyone stands spread out on a field. One player is drawn by lot and is the catcher; they have a ring around their figure.
- On the phone, everyone steers their figure with the d-pad. As long as a button is pressed, the figure runs in that direction.
- The catcher is a little faster than the others. If they touch someone, that player becomes the catcher.
- A new catcher stands still for half a second so the old one can get away. They cannot tag the old catcher back for one second.
- When time is up, whoever was the catcher for the shortest time in total wins. In a tie, everyone with the shortest time wins.
- Every win counts in your own profile; the leaderboard on the game page shows who has won most often.

## Options

- **Duration:** 30 seconds, 1 minute (default) or 1.5 minutes. The host sets it in the lobby.

## Bots and sound

- Empty seats can be filled with bots, and whoever has to go can hand their seat to a bot. As the catcher a bot chases the nearest player, otherwise it runs away from the catcher.
- With the sound switched on, the TV plays the start, every tag, the last five seconds and the end; your phone tells you when you become the catcher and when you got rid of it.
- When a phone is locked, the match pauses until it is back, so nobody loses by accident.

## Languages

English and German. The platform picks the language of each device; in `npm run dev` the selector at the top switches it.

## Try it out

You need Node 22 or newer.

```bash
npm install
npm run dev
```

Then open http://localhost:5180. The TV and all phones are shown there side by side; you can play each seat yourself or give it to a bot. With `npm run dev -- --host` it also works with real phones on the Wi-Fi.

## Develop

This game is easy to build on with an AI agent (Claude Code, Cursor, Copilot …). The instructions for the agent are in [AGENTS.md](AGENTS.md).

| Command | What it does |
|---|---|
| `npm run dev` | starts the game locally with the TV and all phones in the browser |
| `npm test` | tests |
| `npm run typecheck` | type check |
| `npm run check` | checks the game like the platform does, with bot matches tick by tick |
| `npm run pack` | builds the game package for a catalog |

## License

Code under MIT, graphics under CC0 (see [LICENSE](LICENSE) and `manifest.json`).
