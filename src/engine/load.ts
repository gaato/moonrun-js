import type { Diagnostics, SourceMap } from '../diagnostics/diag.ts';
import { err, ok, type Result } from '../ports/result.ts';
import { compileStringModule, stringImports } from './js-string.ts';
import { rememberFunctionBodies } from './stack.ts';

/** A compiled guest, ready to run any number of times. */
export interface LoadedModule {
  readonly module: WebAssembly.Module;
  /** Diagnostic name and argv[0]: the path exactly as given. */
  readonly name: string;
  /** Renders this module's traps and runs its memory sanitizer (moonrun-diag). */
  readonly diagnostics: Diagnostics;
  readonly sourceMap: SourceMap | undefined;
  /** Imports that fill `wasm:js-string` / `_` when the engine did not resolve them natively. */
  readonly stringImports: WebAssembly.Imports;
}

/** A host-side failure, rendered like an anyhow error chain: context first, causes after. */
export interface HostFailure {
  readonly chain: readonly string[];
}

const COMPILE_OPTIONS: WebAssembly.CompileOptions = {
  builtins: ['js-string'],
  importedStringConstants: '_',
};

export function fromCompiled(
  module: WebAssembly.Module,
  name: string,
  diagnostics: Diagnostics,
  sourceMap?: SourceMap,
): LoadedModule {
  return { module, name, diagnostics, sourceMap, stringImports: stringImports(module) };
}

/**
 * Compiles a guest; its source map (`sourceMappingURL` or `<name>.map`) is loaded now,
 * through `diagnostics`' reader, as moonrun does when it loads the file.
 */
export function compileBytes(
  bytes: Uint8Array,
  name: string,
  diagnostics: Diagnostics,
): Result<LoadedModule, HostFailure> {
  let module: WebAssembly.Module;
  try {
    module = compileStringModule(bytes, COMPILE_OPTIONS);
    rememberFunctionBodies(module, bytes);
  } catch (e) {
    // moonrun reports V8's message, which carries the "Uncaught" prefix.
    const cause = e instanceof Error ? `Uncaught ${e.name}: ${e.message}` : `Uncaught ${String(e)}`;
    return err({ chain: [`failed to compile \`${name}\``, cause] });
  }
  return ok(fromCompiled(module, name, diagnostics, diagnostics.loadSourceMap(name, bytes)));
}
