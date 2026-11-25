# Card Duel

A game for [Gamehearth](https://github.com/hearthbit/gamehearth-starter), the self-hosted game platform.

## Rules

For 2 to 4 players. The game uses 30 cards, numbered from 1 to 30.

- Everyone gets 3 cards in their hand, the rest stays face down as the deck.
- In every round, everyone plays a card face down at the same time. The cards are revealed only once everyone has played.
- The highest card gets a point.
- Then everyone draws a new card.
- After the last round, whoever has the most points wins. In a tie, everyone with the most points wins.
- Whoever wins gets a win and a joker. Both stay in your own profile, also for later matches; the wins show up in the leaderboard on the game page.
- If you have a joker, you can play a card with a joker: it then counts double, and the joker is used up.

## Options

- **Rounds:** 3, 5 (default) or 7. The host sets them in the lobby.

## Bots and sound

- Empty seats can be filled with bots, and whoever has to go can hand their seat to a bot. The bot mostly plays its highest card and keeps a joker for the last round.
- With the sound switched on, you hear your own card, the reveal (a coin when you get the point) and the end of the match.

## Languages

English and German. The platform picks the language of each device; in `npm run dev` the selector at the top switches it.

## Try it out

You need Node 22 or newer.

```bash
npm install
npm run dev
```

Then open http://localhost:5180. All players sit there side by side; you can play each seat yourself or give it to a bot.

## Develop

This game is easy to build on with an AI agent (Claude Code, Cursor, Copilot …). The instructions for the agent are in [AGENTS.md](AGENTS.md).

| Command | What it does |
|---|---|
| `npm run dev` | starts the game locally with all players in the browser |
| `npm test` | tests |
| `npm run typecheck` | type check |
| `npm run check` | checks the game like the platform does, with hundreds of bot matches |
| `npm run pack` | builds the game package for a catalog |

## License

Code under MIT, graphics under CC0 (see [LICENSE](LICENSE) and `manifest.json`).
