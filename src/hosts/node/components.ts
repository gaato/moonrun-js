import { readFileSync } from 'node:fs';
import { Diagnostics } from '../../diagnostics/diag.ts';
import { DIAGNOSTICS_URL } from '../../diagnostics/diag-url.ts';
import { POLICY_URL } from '../../domains/policy/policy-url.ts';
import { TLS_ENGINE_URL } from '../../domains/tls/engine-url.ts';
import type { ComponentsPort } from '../../ports/components.ts';
import { err, type HostError, hostError, ok, type Result } from '../../ports/result.ts';

/** moonrun-cli.wasm sits next to this module (the CLI is Node-only). */
export const CLI_URL: URL = new URL('./moonrun-cli.wasm', import.meta.url);

const compiled = new Map<string, WebAssembly.Module>();

/** Compiles a bundled component once per process. */
export function nodeComponentModule(url: URL): Result<WebAssembly.Module, HostError> {
  const known = compiled.get(url.href);
  if (known !== undefined) {
    return ok(known);
  }
  try {
    const module = new WebAssembly.Module(readFileSync(url));
    compiled.set(url.href, module);
    return ok(module);
  } catch (error) {
    return err(hostError('EIO', `cannot load ${url.href}: ${String(error)}`));
  }
}

export function nodeComponents(): ComponentsPort {
  return {
    sqliteEngine: () =>
      nodeComponentModule(new URL('../../domains/sqlite/sqlite-engine.wasm', import.meta.url)),
    policy: () => nodeComponentModule(POLICY_URL),
    tlsEngine: () => nodeComponentModule(TLS_ENGINE_URL),
  };
}

/** The diagnostics component; its compile failure is a broken installation. */
export function nodeDiagnosticsModule(): WebAssembly.Module {
  const module = nodeComponentModule(DIAGNOSTICS_URL);
  if (!module.ok) {
    throw new Error(module.error.message);
  }
  return module.value;
}

/** Diagnostics whose source maps are read from the host filesystem (paths as given). */
export function nodeDiagnostics(): Diagnostics {
  return new Diagnostics(nodeDiagnosticsModule(), {
    readFile: (p) => {
      try {
        return new Uint8Array(readFileSync(p));
      } catch {
        return undefined;
      }
    },
  });
}
