# moonrun-js

TypeScript reimplementation of MoonBit's `moonrun`. Compatibility with the installed
moonrun (`0.1.20261012`, moon commit `748b63c`) is the yardstick: same wasm, same
stdout/stderr/exit.

- Design and phases: `docs/plan.md`. Spike results: `docs/spikes.md`. Known differences: `docs/divergences.md`.
- Read moonrun sources at the reference commit: `git -C ~/ghq/github.com/moonbitlang/moon show 748b63c:crates/moonrun/src/<file>`.
- Layers (checked by `node scripts/check-layers.ts`): `engine -> abi -> domains -> kernel -> ports <- hosts`. Only `src/hosts/` may import `node:*`.
- Imports are declared with `fn`/`suspending` in `src/abi/define.ts`; never write handler argument types by hand.
- Ports and domains return `Result`; only `src/abi/` turns failures into guest conventions.
- Checks: `pnpm typecheck`, `pnpm lint`, `pnpm test`. Run tools through `mise exec --`.
