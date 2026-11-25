# Mushroom Hunt

A single-player game for [Gamehearth](https://github.com/hearthbit/gamehearth-starter), the self-hosted game platform. You play alone, even without a connection to the server; the platform keeps your save and your best time.

## Rules

- A character runs through a maze and collects all mushrooms. You steer with the d-pad at the bottom or the arrow keys (also W, A, S, D). As long as you press, the figure runs in that direction.
- Once all mushrooms of a level are collected, the level is done. There are 3 levels.
- The time runs as long as you are in a level and is added up across the levels.
- Whoever clears all 3 levels in one go, starting at Level 1, gets their total time as their best time; shorter is better.
- Between levels the game remembers where you are: you can stop and continue later with the next level. If you stop in the middle of a level, that level starts over next time, but the time already spent still counts.
- Cleared levels stay unlocked and can be practiced one at a time; practiced levels do not count for the best time.

## Sound

With the sound switched on, you hear the start of a level, every mushroom, a level done and the end of the run.

## Languages

English and German. The platform picks the language of each device; in `npm run dev` the selector at the top switches it.

## Try it out

You need Node 22 or newer.

```bash
npm install
npm run dev
```

Then open http://localhost:5180. The game is shown there in a phone frame, below it the save and the best time to look at and delete. With `npm run dev -- --host` it also works with a real phone on the Wi-Fi.

## Develop

This game is easy to build on with an AI agent (Claude Code, Cursor, Copilot …). The instructions for the agent are in [AGENTS.md](AGENTS.md).

| Command | What it does |
|---|---|
| `npm run dev` | starts the game locally in the browser, with a view of the save and the best scores |
| `npm test` | tests |
| `npm run typecheck` | type check |
| `npm run check` | checks the game like the platform does |
| `npm run pack` | builds the game package for a catalog |

## License

Code under MIT, graphics under CC0 (see [LICENSE](LICENSE) and `manifest.json`).
