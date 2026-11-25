# Reihum

A small realtime test game for the platform, not a catalog game. The seats take turns pressing a button; whose turn it is has 3 seconds.

In the monorepo it checks what step 15 added: a game function `bot`, `"away": "play-on"` with `ctx.away` (a seat that is away is skipped instead of pausing the match) and sounds through the platform (`game.sound`, `game.soundOn`). Server, `check` and browser tests use it. Like the other test games it changes only when tests need it.

## Rules

- 2–4 players, each on their own device.
- Only the seat whose turn it is may press ("Drücken"). After a press or after 3 seconds the turn passes on.
- A seat that is away is skipped; the game lists it under "Übersprungen".
- The bot presses half a second into its turn.
- The match ends after 20 presses or 2 minutes; whoever pressed most wins.
- Pressing plays "blip", the end "win" or "lose"; the page shows whether sound is on.

## License

Code MIT, see [LICENSE](LICENSE). The game has no graphics.
