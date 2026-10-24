// moonrun's guest diagnostics, from the moonrun-diag component (crates/moonrun-diag:
// upstream source_map.rs, wasm_diagnostic.rs, memory_sanitizer.rs and moonutil's
// demangle.rs, verbatim). One instance serves any number of modules and runs.
import { ComponentAbi, nulList } from '../components/abi.ts';
import { NO_OS, type OsBinding, osImports } from '../components/os.ts';

/** One line of an engine stack, after parsing (moonrun `DiagnosticLine`). */
export type DiagnosticLine =
  | { readonly kind: 'text'; readonly text: string }
  | {
      readonly kind: 'frame';
      readonly indentation: string;
      readonly fn: string;
      readonly moduleOffset: number | undefined;
      readonly runtimeLocation?: string;
    };

/** Reads a source map file; `undefined` when it cannot be read. */
export interface DiagnosticsIo {
  readFile(path: string): Uint8Array | undefined;
}

/** A source map loaded into one Diagnostics instance. */
export class SourceMap {
  readonly owner: Diagnostics;
  readonly id: number;

  constructor(owner: Diagnostics, id: number) {
    this.owner = owner;
    this.id = id;
  }
}

/** The memory sanitizer of one run (`moonbit:ffi/memory-sanitizer`). */
export interface Sanitizer {
  /** `undefined`, or the error text (`object N is already live …`). */
  registerAlloc(size: number, ptr: number, frames: readonly string[]): string | undefined;
  registerFree(ptr: number): string | undefined;
  isValid(ptr: number): boolean;
  /** `undefined`, or the leak report. */
  checkLeaks(): string | undefined;
  dispose(): void;
}

const ENOENT = 2;

export class Diagnostics {
  readonly #abi: ComponentAbi;
  readonly #maps = new FinalizationRegistry<number>((id) => {
    this.#abi.fn('diag_source_map_free')(id);
  });

  constructor(module: WebAssembly.Module, io?: DiagnosticsIo) {
    let binding: OsBinding | undefined;
    const imports = osImports(
      {
        ...NO_OS,
        readFile: (path) => {
          const bytes = io?.readFile(path);
          return bytes === undefined ? { ok: false, errno: ENOENT } : { ok: true, value: bytes };
        },
      },
      () => {
        if (binding === undefined) {
          throw new Error('moonrun-diag: import called during instantiation');
        }
        return binding;
      },
    );
    const instance = new WebAssembly.Instance(module, imports);
    binding = instance.exports as unknown as OsBinding;
    this.#abi = new ComponentAbi(instance, 'diag');
  }

  /** `source_map::load(wasm_path, wasm)`: a `sourceMappingURL` or `<path>.map` next to it. */
  loadSourceMap(wasmPath: string, wasm: Uint8Array): SourceMap | undefined {
    const id = this.#abi.call('diag_source_map_load', wasmPath, wasm);
    if (id === 0) {
      return undefined;
    }
    const map = new SourceMap(this, id);
    this.#maps.register(map, id);
    return map;
  }

  /** `wasm_diagnostic::render`. */
  render(
    lines: readonly DiagnosticLine[],
    map: SourceMap | undefined,
    noStackTrace: boolean,
  ): string {
    const json = JSON.stringify(
      lines.map((line) =>
        line.kind === 'text'
          ? line.text
          : {
              indentation: line.indentation,
              function: line.fn,
              offset: line.moduleOffset ?? null,
              location: line.runtimeLocation ?? null,
            },
      ),
    );
    const id = map !== undefined && map.owner === this ? map.id : 0;
    if (this.#abi.call('diag_render', json, id, noStackTrace ? 1 : 0) !== 0) {
      throw new Error('moonrun-diag: render rejected its input');
    }
    return this.#abi.resultText();
  }

  /** moonutil `demangle_mangled_function_name`. */
  demangle(name: string): string {
    this.#abi.call('diag_demangle', name);
    return this.#abi.resultText();
  }

  sanitizer(): Sanitizer {
    const abi = this.#abi;
    const id = abi.fn('diag_sanitizer_new')();
    const status = (code: number): string | undefined =>
      code === 0 ? undefined : abi.resultText();
    return {
      registerAlloc: (size, ptr, frames) =>
        status(abi.call('diag_sanitizer_alloc', id, size, ptr, nulList(frames))),
      registerFree: (ptr) => status(abi.fn('diag_sanitizer_free_object')(id, ptr)),
      isValid: (ptr) => abi.fn('diag_sanitizer_is_valid')(id, ptr) !== 0,
      checkLeaks: () => status(abi.fn('diag_sanitizer_check_leaks')(id)),
      dispose: () => {
        abi.fn('diag_sanitizer_free')(id);
      },
    };
  }
}
