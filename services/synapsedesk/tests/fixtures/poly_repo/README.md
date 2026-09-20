# poly_repo fixture (multi-language stand-in)

Exercises the universal tiers in one small repo:

- `app.ts` / `lib.js` — Tier-1 TS/JS (`ts-treesitter` when installed): symbols,
  `./lib` relative import edge, `helper()` resolved, `missing()` explicit external
- `main.c` / `util.h` — Tier-1 C (`c-treesitter`): `total`/`main` defs, quoted
  sibling-header edge, `add()` explicit external
- `Main.java` / `Helper.java` — Tier-1 Java (`java-treesitter`): classes +
  methods, `Helper.greet()` resolved across sibling files, `missing()` external
- `app.kt` — Tier-1 Kotlin (`kotlin-treesitter`): `Server`/`run`, `run()` → `main()`
- `server.go` / `util.go` + `go.mod` — Tier-1 Go (`go-treesitter`): `Shout`/`Greeter`,
  `util.Shout()` resolved in-package, `lone()` external, module + dep edges
- `deploy.rb` — Tier-2 heuristic (`parser: heuristic`, `verified: false`):
  defs + imports only, calls never invented
- `package.json` — npm manifest → `Project -> Package` nodes + dependency edges

Without grammar extras every file still resolves to heuristic/inventory —
nothing is silently dropped. See `tests/test_universal.py`.
