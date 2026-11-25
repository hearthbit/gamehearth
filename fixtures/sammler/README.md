# Sammler

A small single-player test game without a reducer (`mode: "single"`, `server: false`), not a catalog game and without an engine. In the monorepo it checks what single-player games need: `connectSolo`, the save, best scores with `higher` and `lower`, the single-player page without a room and offline preloading. Server, UI and browser tests use it. Like Mau-Mau it changes only when tests need it.

## Rules

- "Star" ("Stern") collects a star; the save (stars of the current round, number of rounds) is stored after every star.
- "End round" ("Runde beenden") records the stars as best score `sterne` (more is better) and as `dauer` 60 seconds minus one second per star (less is better, time format), and starts a new round.
- "Report wrong" ("Falsch melden") records a best score that the manifest does not know; the platform rejects it, and the game shows the error. `check` therefore deliberately reports this call as an error.
- The image `stern@2x.svg` checks that preloading also stores file names with `@` the way the game requests them offline.
