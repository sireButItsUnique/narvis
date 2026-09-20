# rust_repo fixture (PengWM stand-in)

Proves the generic `RepoAdapter` seam with a Cargo workspace: `wm` + `adapter`
crates carrying `StateManager`, `Workspace`, `OsAdapter` analogues, plus `mod`
links, `#[cfg]`, a macro invocation, and an unresolved call.

PengWM itself (4 crates) stays the integration gate in the shared understanding;
this fixture keeps unit tests hermetic. Run with parsing:
`pip install -e .[rust]` (or `Setup.ps1 -Rust`), then `python -m unittest discover -s tests`.
Without the extra, Rust files fall back to inventory-only `coverage`.
