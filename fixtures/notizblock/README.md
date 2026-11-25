# Notizblock

A small realtime test game for the platform, not a catalog game. Everyone types notes and spills ink onto a shared pad; a paired TV may show the pad, but the match does not need one.

In the monorepo it checks what step 14 added: placeholders in `legalMoves` (a typed note and a text of ink points), a text in the state that keeps growing (frames then carry only the new part) and an optional TV. Server, `check` and browser tests use it. Like the other test games it changes only when tests need it.

## Rules

- 1–4 players, each on their own device; a TV is optional.
- "Notieren" or Enter puts the typed note (1–30 characters) on the pad; the pad keeps the last 20 notes. The game frame does not submit forms, so the UI listens to the button and to Enter itself.
- "Tinte" adds 40 ink points; the pad holds at most 20,000. An ink input that the platform drops (too many inputs at once) is sent again, as inputs that must not get lost should be.
- "Fertig" ends the match, otherwise it ends after 2 minutes. Nobody wins.

## License

Code MIT, see [LICENSE](LICENSE). The game has no graphics.
