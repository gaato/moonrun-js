import { randomBytes } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  FILE_CONTEXT,
  INHERITED_CONTEXT,
  type LoadedPolicy,
  loadInheritedPolicy,
  loadPolicyFile,
  osErrorText,
  type PolicyError,
} from '../../domains/policy/index.ts';
import type { CanonicalPort } from '../../domains/policy/paths.ts';
import {
  err,
  type HostError,
  type HostErrorCode,
  hostError,
  ok,
  type Result,
} from '../../ports/result.ts';

/** Name of the variable moonrun uses to hand a policy to child runs (`moonutil::constants`). */
export const MOONRUN_INHERITED_POLICY = 'MOONRUN_INHERITED_POLICY';

function toHostError(e: unknown): HostError {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  const message = e instanceof Error ? e.message : String(e);
  return hostError((typeof code === 'string' ? code : 'EIO') as HostErrorCode, message);
}

/** `std::fs::canonicalize`. */
export const nodeCanonical: CanonicalPort = {
  realpath(p) {
    try {
      return ok(realpathSync.native(p));
    } catch (e) {
      return err(toHostError(e));
    }
  },
};

function hostEnvEntries(env: NodeJS.ProcessEnv): Array<readonly [string, string]> {
  return Object.entries(env).flatMap(([k, v]) => (v === undefined ? [] : [[k, v] as const]));
}

/**
 * `PolicyTransfer::take_from_env` + `read`: if the variable is present it is removed from `env`
 * (before anything else can copy it) and the file descriptor it names is read to the end.
 * Returns `undefined` when there is no inherited policy. Errors are moonrun's bare chains
 * (no "failed to load sandbox policy" wrapper).
 */
export function takeInheritedPolicy(
  env: NodeJS.ProcessEnv = process.env,
): Result<string | undefined, PolicyError> {
  const token = env[MOONRUN_INHERITED_POLICY];
  if (token === undefined) {
    return ok(undefined);
  }
  delete env[MOONRUN_INHERITED_POLICY];
  const fdError = 'invalid inherited Moonrun Policy file descriptor';
  if (!/^[+-]?\d+$/.test(token)) {
    return err({
      chain: [
        fdError,
        token === '' ? 'cannot parse integer from empty string' : 'invalid digit found in string',
      ],
    });
  }
  const fd = Number(token);
  if (fd > 2147483647 || fd < -2147483648) {
    return err({ chain: [fdError, 'number too large to fit in target type'] });
  }
  if (fd <= 2) {
    return err({ chain: [fdError] });
  }
  try {
    fstatSync(fd);
  } catch (e) {
    return err({
      chain: [
        'failed to isolate inherited Moonrun Policy file descriptor',
        osErrorText(toHostError(e)),
      ],
    });
  }
  const chunks: Buffer[] = [];
  try {
    const buf = Buffer.allocUnsafe(65536);
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) {
        break;
      }
      chunks.push(Buffer.from(buf.subarray(0, n)));
    }
  } catch (e) {
    return err({ chain: ['failed to read inherited Moonrun Policy', osErrorText(toHostError(e))] });
  } finally {
    try {
      closeSync(fd);
    } catch {
      // The descriptor is only ours to read once.
    }
  }
  return ok(Buffer.concat(chunks).toString('utf8'));
}

export interface PolicyRequest {
  /** `--policy PATH`, exactly as given. Ignored when an inherited policy is present. */
  readonly policyPath?: string | undefined;
  /** Hidden `--policy-source-dir`. */
  readonly sourceDir?: string | undefined;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Resolves the run's policy like moonrun's `main` + `Runtime::new`: an inherited policy wins and
 * cannot be replaced from the command line; otherwise `--policy` is read; with neither, the run
 * is unrestricted (`undefined`). The inherited variable is always removed from `env`.
 * Call this before argument parsing, as moonrun does.
 */
export function loadRunPolicy(
  request: PolicyRequest = {},
): Result<LoadedPolicy | undefined, PolicyError> {
  const env = request.env ?? process.env;
  const inherited = takeInheritedPolicy(env);
  if (!inherited.ok) {
    return inherited;
  }
  const options = { canonical: nodeCanonical, hostEnv: hostEnvEntries(env) };
  if (inherited.value !== undefined) {
    return loadInheritedPolicy(inherited.value, options);
  }
  const file = request.policyPath;
  if (file === undefined) {
    return ok(undefined);
  }
  let contents: string;
  const isMbtx = file.toLowerCase().endsWith('.mbtx');
  try {
    contents = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(file));
  } catch (e) {
    const detail =
      e instanceof TypeError ? 'stream did not contain valid UTF-8' : osErrorText(toHostError(e));
    return err({
      chain: [
        FILE_CONTEXT,
        isMbtx ? `failed to read .mbtx file \`${file}\`` : `failed to read policy ${file}`,
        detail,
      ],
    });
  }
  return loadPolicyFile(file, contents, { ...options, sourceDir: request.sourceDir });
}

export { INHERITED_CONTEXT };

/**
 * Materializes the inheritance payload as an anonymous file (created, unlinked, written with a
 * positional write so the offset stays 0) and returns its descriptor. Pass it to the child as an
 * extra `stdio` entry at index >= 3 and set `MOONRUN_INHERITED_POLICY` to that index.
 * The caller closes the descriptor once the child has been created.
 */
export function openPolicyTransfer(payload: string): number {
  const file = path.join(tmpdir(), `moonrun-policy-${randomBytes(8).toString('hex')}`);
  const fd = openSync(file, 'wx+', 0o600);
  try {
    unlinkSync(file);
    const bytes = Buffer.from(payload, 'utf8');
    let written = 0;
    while (written < bytes.length) {
      written += writeSync(fd, bytes, written, bytes.length - written, written);
    }
  } catch (e) {
    closeSync(fd);
    throw e;
  }
  return fd;
}
