import { err, type HostError, ok, type Result } from '../../ports/result.ts';
import { type PolicyConfig, serializeInheritedConfig, toPolicyConfig } from './config.ts';
import { type EnvEntries, provisionEnv } from './env.ts';
import { type FsPolicy, rootsFromConfig } from './fs.ts';
import { buildNetPolicy, type NetPolicy } from './net.ts';
import { type CanonicalPort, isAbsolute, joinPath, parentPath } from './paths.ts';
import { buildProcessPolicy, type ProcessPolicy } from './process.ts';
import { rustTrimStart } from './rust-fmt.ts';
import { POLICY_SCHEMA } from './schema.ts';
import { parseJsonWithSchema } from './serde-json.ts';
import { parseTomlWithSchema } from './toml.ts';
import { extractMbtxFrontMatter, parseYamlPolicy } from './yaml.ts';

/** The realized, immutable policy of a run. No policy at all is represented by `undefined`. */
export interface Policy {
  readonly fs: FsPolicy;
  readonly net: NetPolicy;
  readonly process: ProcessPolicy;
  /** What a child moonrun receives through `MOONRUN_INHERITED_POLICY` (JSON text). */
  readonly inheritance: string;
}

export interface LoadedPolicy {
  readonly policy: Policy;
  /** Initial environment of the run (sorted, unique names). */
  readonly env: EnvEntries;
}

/** An `anyhow` error chain, outermost context first (what `formatErrorChain` prints). */
export interface PolicyError {
  readonly chain: readonly string[];
}

export const FILE_CONTEXT =
  'failed to load sandbox policy (experimental); run `moonrun --help` for policy format notes';
export const INHERITED_CONTEXT = 'failed to load inherited sandbox policy (experimental)';

export type PolicyFormat = 'mbtx' | 'json' | 'toml';

const hasExtension = (path: string, ext: string): boolean =>
  path.toLowerCase().endsWith(`.${ext}`) && path.length > ext.length + 1;

/** `PolicyConfig::from_file` format selection: `.mbtx`, then `.json` or a leading `{`, else TOML. */
export function detectPolicyFormat(path: string, contents: string): PolicyFormat {
  if (hasExtension(path, 'mbtx')) {
    return 'mbtx';
  }
  return hasExtension(path, 'json') || rustTrimStart(contents).startsWith('{') ? 'json' : 'toml';
}

/** Rust `io::Error` Display for the failures a root lookup can produce. */
export function osErrorText(error: HostError): string {
  const table: Readonly<Record<string, readonly [string, number]>> = {
    EPERM: ['Operation not permitted', 1],
    ENOENT: ['No such file or directory', 2],
    EIO: ['Input/output error', 5],
    EBADF: ['Bad file descriptor', 9],
    EACCES: ['Permission denied', 13],
    ENOTDIR: ['Not a directory', 20],
    EISDIR: ['Is a directory', 21],
    EINVAL: ['Invalid argument', 22],
    ENAMETOOLONG: ['File name too long', 36],
    ELOOP: ['Too many levels of symbolic links', 40],
  };
  const entry = table[error.code];
  return entry === undefined ? (error.message ?? error.code) : `${entry[0]} (os error ${entry[1]})`;
}

/** Parses a policy file's text. `path` is exactly what the user passed (it appears in messages). */
export function parsePolicyFile(path: string, contents: string): Result<PolicyConfig, PolicyError> {
  switch (detectPolicyFormat(path, contents)) {
    case 'mbtx': {
      const yaml = extractMbtxFrontMatter(contents);
      if (yaml === undefined) {
        return err({ chain: [`.mbtx policy source ${path} has no \`// policy:\` front matter`] });
      }
      const r = parseYamlPolicy(yaml, POLICY_SCHEMA);
      return r.ok
        ? ok(toPolicyConfig(r.value))
        : err({ chain: [`failed to parse YAML front matter in .mbtx file \`${path}\``, r.error] });
    }
    case 'json': {
      const r = parseJsonWithSchema(contents, POLICY_SCHEMA);
      return r.ok
        ? ok(toPolicyConfig(r.value))
        : err({ chain: [`failed to parse JSON policy ${path}`, r.error] });
    }
    case 'toml': {
      const r = parseTomlWithSchema(contents, POLICY_SCHEMA);
      return r.ok
        ? ok(toPolicyConfig(r.value))
        : err({ chain: [`failed to parse policy ${path}`, r.error] });
    }
  }
}

export interface RealizeOptions {
  /** Directory that relative roots resolve against (`--policy-source-dir`, else the policy file's directory). */
  readonly configDir: string;
  /** Strict `realpath` used to canonicalize roots. */
  readonly canonical: CanonicalPort;
  /** The host environment `env.from_host` copies from. */
  readonly hostEnv: EnvEntries;
}

/**
 * `realize_config`: canonicalize filesystem roots, then build each section in moonrun's order
 * (inheritance payload, fs, net, env, process) so the first failing section is the one reported.
 */
export function realizePolicy(
  config: PolicyConfig,
  options: RealizeOptions,
): Result<LoadedPolicy, PolicyError> {
  const canonicalizeRoots = (roots: readonly string[]): Result<string[], PolicyError> => {
    const out: string[] = [];
    for (const root of roots) {
      if (root === '*') {
        out.push(root);
        continue;
      }
      const path = isAbsolute(root) ? root : joinPath(options.configDir, root);
      const real = options.canonical.realpath(path);
      if (!real.ok) {
        return err({
          chain: [`failed to resolve sandbox filesystem root ${path}`, osErrorText(real.error)],
        });
      }
      out.push(real.value);
    }
    return ok(out);
  };
  let canonicalFs: PolicyConfig['fs'] = null;
  if (config.fs !== null) {
    const read = canonicalizeRoots(config.fs.read);
    if (!read.ok) {
      return read;
    }
    const write = canonicalizeRoots(config.fs.write);
    if (!write.ok) {
      return write;
    }
    canonicalFs = { read: read.value, write: write.value };
  }
  const canonicalConfig: PolicyConfig = { ...config, fs: canonicalFs };
  const inheritance = serializeInheritedConfig(canonicalConfig);
  const fs: FsPolicy = {
    read: rootsFromConfig(canonicalFs?.read ?? []),
    write: rootsFromConfig(canonicalFs?.write ?? []),
  };
  const net = buildNetPolicy(config.net ?? { dns: [], connect: [], bind: [] });
  if (!net.ok) {
    return err({ chain: net.error });
  }
  const env = provisionEnv(
    config.env ?? { fromHost: [], requiredFromHost: [], set: new Map() },
    options.hostEnv,
  );
  if (!env.ok) {
    return err({ chain: env.error });
  }
  const process = buildProcessPolicy(config.process ?? { spawn: false, allow: [] });
  if (!process.ok) {
    return err({ chain: process.error });
  }
  return ok({
    policy: { fs, net: net.value, process: process.value, inheritance },
    env: env.value,
  });
}

const withContext = (error: PolicyError, context: string): PolicyError => ({
  chain: [context, ...error.chain],
});

export interface FileLoadOptions extends Omit<RealizeOptions, 'configDir'> {
  /** `--policy-source-dir`, if given. */
  readonly sourceDir?: string | undefined;
}

/** `load_file_with_source_dir`, given the file's already-read text. */
export function loadPolicyFile(
  path: string,
  contents: string,
  options: FileLoadOptions,
): Result<LoadedPolicy, PolicyError> {
  const parsed = parsePolicyFile(path, contents);
  if (!parsed.ok) {
    return err(withContext(parsed.error, FILE_CONTEXT));
  }
  const configDir = options.sourceDir ?? parentPath(path) ?? '.';
  const realized = realizePolicy(parsed.value, { ...options, configDir });
  return realized.ok ? realized : err(withContext(realized.error, FILE_CONTEXT));
}

/** `load_inherited_json`: roots are already absolute; they are re-canonicalized to prove they still exist. */
export function loadInheritedPolicy(
  contents: string,
  options: Omit<RealizeOptions, 'configDir'>,
): Result<LoadedPolicy, PolicyError> {
  const parsed = parseJsonWithSchema(contents, POLICY_SCHEMA);
  if (!parsed.ok) {
    return err({
      chain: [INHERITED_CONTEXT, 'failed to parse inherited JSON Moonrun Policy', parsed.error],
    });
  }
  const realized = realizePolicy(toPolicyConfig(parsed.value), { ...options, configDir: '.' });
  return realized.ok ? realized : err(withContext(realized.error, INHERITED_CONTEXT));
}
