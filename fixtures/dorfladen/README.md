# Dorfladen

A small turn-based test game for the platform, not a catalog game. Taking turns, everyone works for coins, buys apples with them and eats them for points. Coins and apples are in the profile and persist across matches and rooms.

In the monorepo it checks what profiles need: the catalog in the manifest (items, stats with and without `better`, a stat in time format, flags with `true` and text, a deprecated item), `ctx.profiles` in `legalMoves`, `ctx.profile.add`, `use`, `stat`, `record` and `flag` in `apply`, `update.profile` in the client, the leaderboards of the game page and `ids.lock`. Server, `check` and browser tests use it. Like Mau-Mau and Glücksrad it changes only when tests need it.

It is also the test game for multilingual support: `languages` (German first, then English), a translated description and translated labels of options, items, stats and flags, a pixel-art cover (`client/public/cover.svg`, CC0, copied by Vite into the built client folder) and a client that shows the language it gets from the platform (`game.language` as `data-language` on `#app`, as `lang` of the page and in the line "Sprache: …", test ID `language`). The texts of its own client stay German.

## Rules

- 1–4 players, one move each in turn.
- **Work** ("Arbeiten"): +2 coins in the profile, +1 point.
- **Buy apple** ("Apfel kaufen"): 3 coins for an apple (only with enough coins).
- **Eat apple** ("Apfel essen"): one apple less, +3 points; the flag "eaten" ("gegessen") is set.
- After the last round, whoever has the most points wins. Everyone gets a played match and their best score credited; winners also get a win, their match duration as "Shortest match" ("Kürzeste Partie") and the title "Shop king" ("Ladenkönig").

## Options

- **Rounds** ("Runden"): 2, 3 (default) or 5.
