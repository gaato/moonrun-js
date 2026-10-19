import { readFileSync } from 'node:fs';
import { TLS_ENGINE_URL } from '../../domains/tls/engine-url.ts';
import { err, ok, type Result } from '../../ports/result.ts';

let compiled: WebAssembly.Module | undefined;

/** Compiles the bundled tls-engine.wasm once per process. */
export function nodeTlsEngineModule(): Result<WebAssembly.Module, string> {
  if (compiled === undefined) {
    try {
      compiled = new WebAssembly.Module(readFileSync(TLS_ENGINE_URL));
    } catch (error) {
      return err(`cannot load ${TLS_ENGINE_URL.href}: ${String(error)}`);
    }
  }
  return ok(compiled);
}
