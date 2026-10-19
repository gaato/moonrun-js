import { TLS_ENGINE_URL } from '../../domains/tls/engine-url.ts';
import { err, ok, type Result } from '../../ports/result.ts';
import { nodeComponentModule } from './components.ts';

/** Compiles the bundled tls-engine.wasm once per process (shared with `nodeComponents().tlsEngine`). */
export function nodeTlsEngineModule(): Result<WebAssembly.Module, string> {
  const module = nodeComponentModule(TLS_ENGINE_URL);
  return module.ok ? ok(module.value) : err(module.error.message ?? module.error.code);
}
