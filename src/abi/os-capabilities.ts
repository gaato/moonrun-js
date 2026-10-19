import type { OsCapabilities, Outcome } from '../components/os.ts';
import type { Host } from '../ports/host.ts';
import type { HostError, Result } from '../ports/result.ts';
import { errnoOf, strerrorOfErrno } from './errno.ts';

function outcome<T, U>(result: Result<T, HostError>, map: (value: T) => U): Outcome<U> {
  return result.ok
    ? { ok: true, value: map(result.value) }
    : { ok: false, errno: errnoOf(result.error.code) };
}

const same = <T>(value: T): T => value;

/**
 * The OS-equivalent layer of the wasm components (crates/os) over a run's ports, with
 * Linux errno numbers and glibc texts. `env` is the environment the component sees for
 * its ambient backing (the host's; a provisioned environment lives in the component).
 */
export function osCapabilities(
  host: Host,
  writeStderr: (bytes: Uint8Array) => void,
): OsCapabilities {
  return {
    readFile: (p) => outcome(host.fs.readFile(p), same),
    writeFile: (p, data) => outcome(host.fs.writeFile(p, data), same),
    readDir: (p) => outcome(host.fs.readDir(p), same),
    stat: (p, follow) => outcome(follow ? host.files.stat(p) : host.files.lstat(p), (s) => s.kind),
    // Rust `create_dir` uses mode 0o777 (before the umask).
    mkdir: (p) => outcome(host.files.mkdir(p, 0o777), same),
    removeFile: (p) => outcome(host.fs.removeFile(p), same),
    removeDirAll: (p) => outcome(host.fs.removeDirAll(p), same),
    realpath: (p) => outcome(host.files.realpath(p), same),
    cwd: () => outcome(host.fs.cwd(), same),
    envEntries: () => host.env.entries(),
    getenv: (name) => host.env.get(name),
    setenv: (name, value) => host.env.set(name, value),
    unsetenv: (name) => host.env.unset(name),
    strerror: strerrorOfErrno,
    writeStderr,
  };
}
