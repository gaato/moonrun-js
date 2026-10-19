# moonrun-js

TypeScript reimplementation of MoonBit's `moonrun`. Compatibility with the installed
moonrun (`0.1.20261012`, moon commit `748b63c`) is the yardstick: same wasm, same
stdout/stderr/exit.

- Design and phases: `docs/plan.md`. Spike results: `docs/spikes.md`. Known differences: `docs/divergences.md`.
- Upstreams are shallow submodules (`upstream/moon`, `upstream/async`; the gitlink is the pin). After cloning run `git submodule update --init --depth 1` (not recursive). Read sources at the pin: `git -C upstream/moon show HEAD:crates/moonrun/src/<file>`; scripts use `scripts/upstream.ts`. Move a pin with `node scripts/bump-upstream.ts <name> <commit>` and commit the gitlink with git (jj ignores gitlinks).
- Parts of moonrun's own Rust source are compiled to wasm components (`crates/`, `docs/reuse.md`): `node scripts/sync-upstream.ts` extracts them, `node scripts/build-wasm.ts` builds the committed `.wasm` files (both have `--check`).
- Layers (checked by `node scripts/check-layers.ts`): `engine -> abi -> domains -> kernel -> ports <- hosts`. Only `src/hosts/` may import `node:*`.
- Imports are declared with `fn`/`suspending` in `src/abi/define.ts`; never write handler argument types by hand.
- Ports and domains return `Result`; only `src/abi/` turns failures into guest conventions.
- Checks: `pnpm typecheck`, `pnpm lint`, `pnpm test`. Run tools through `mise exec --`.
