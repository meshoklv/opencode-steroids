# Contributing

Issues and pull requests are welcome.

- `npm test` runs the offline suite (Node >= 22.6, no network, no model calls); `npm run check` syntax-checks every file.
- Keep `plugin/steroids.ts` to exactly one `export` (a second one breaks opencode's plugin loader), and keep the library in `plugin/lib/`.
- A change to the injected data protocol must be mirrored in `docs/DATA_PROTOCOL.md` (see "How to verify" in `docs/LIMITATIONS.md`).
- Claims about model or API behaviour need a measurement; add it to `docs/FACTS.md`.
