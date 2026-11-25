# Wettlauf

A small realtime test game for the platform, not a catalog game. The TV shows the track, every phone is a controller with one button "Run" ("Laufen").

In the monorepo it checks what realtime needs: `tick` at 20 Hz, inputs that are collected until the next tick, the roles `screen` and `controller`, pairing the TV and smoothing with `createTimeline`. Server, `check` and browser tests use it. Like Mau-Mau it changes only when tests need it.

## Rules

- 2–4 players.
- As long as someone holds the button, their figure runs one field per tick.
- Whoever reaches 100 fields first wins; several in the same tick win together.
- After 60 seconds, whoever is furthest wins.
