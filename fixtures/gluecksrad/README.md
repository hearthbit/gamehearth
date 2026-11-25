# Glücksrad

A small turn-based test game for the platform, not a catalog game. Taking turns, everyone spins the wheel; the wheel draws 1, 3 or 10 points with `random.weighted`.

In the monorepo it checks what game options need: options in the manifest, the host's choice in the lobby, `ctx.options` in `setup` and `legalMoves`, `update.options` in the client and `check` with every value of every option. Server, `check` and browser tests use it. Like Mau-Mau and Wettlauf it changes only when tests need it.

## Rules

- 1–4 players.
- Whoever's turn it is spins: 1 point (6 in 10), 3 points (3 in 10) or 10 points (1 in 10).
- After the last round, whoever has the most points wins; a tie wins together.

## Options

- **Rounds** ("Runden"): 2, 3 (default) or 5.
- **Joker:** With "yes" ("ja") everyone may spin once with the joker and then gets double points. Default is "no" ("nein").
