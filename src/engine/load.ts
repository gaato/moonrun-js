import { loadSourceMap, type SourceMap, type SourceMapIo } from '../diagnostics/source-map.ts';
import { err, ok, type Result } from '../ports/result.ts';
import { stringImports } from './js-string.ts';

/** A compiled guest, ready to run any number of times. */
export interface LoadedModule {
  readonly module: WebAssembly.Module;
  /** Diagnostic name and argv[0]: the path exactly as given. */
  readonly name: string;
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
  sourceMap?: SourceMap,
): LoadedModule {
  return { module, name, sourceMap, stringImports: stringImports(module) };
}

export function compileBytes(
  bytes: Uint8Array,
  name: string,
  sourceMapIo?: SourceMapIo,
): Result<LoadedModule, HostFailure> {
  let module: WebAssembly.Module;
  try {
    module = new WebAssembly.Module(bytes, COMPILE_OPTIONS);
  } catch (e) {
    // moonrun reports V8's message, which carries the "Uncaught" prefix.
    const cause = e instanceof Error ? `Uncaught ${e.name}: ${e.message}` : `Uncaught ${String(e)}`;
    return err({ chain: [`failed to compile \`${name}\``, cause] });
  }
  const sourceMap = sourceMapIo === undefined ? undefined : loadSourceMap(name, bytes, sourceMapIo);
  return ok(fromCompiled(module, name, sourceMap));
}
