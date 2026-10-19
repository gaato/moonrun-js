import type { FilePort, HostFd } from '../../ports/files.ts';
import { fail, fromHostError, WasiErrno } from './errno.ts';

/** The `std::fs::OpenOptions` moonrun builds for a WASI file open. */
export interface OpenOptions {
  readonly read: boolean;
  readonly write: boolean;
  readonly append: boolean;
  readonly create: boolean;
  readonly createNew: boolean;
  readonly truncate: boolean;
}

/**
 * Opens like moonrun's `path_open`: read unless only writing; write whenever
 * writing, appending or creating (Rust requires it for O_CREAT); then Rust's own
 * `get_access_mode`/`get_creation_mode` validation, which rejects with EINVAL.
 */
export function openFile(files: FilePort, path: string, wanted: OpenOptions): HostFd {
  const read = wanted.read || !wanted.write;
  const write = wanted.write || wanted.append || wanted.create;
  const { append, create, createNew, truncate } = wanted;
  if (!write && !append && (truncate || create || createNew)) {
    fail(WasiErrno.INVAL);
  }
  if (append && truncate && !createNew) {
    fail(WasiErrno.INVAL);
  }
  const opened = files.open(path, {
    access: read && (write || append) ? 'readWrite' : read ? 'read' : 'write',
    append,
    create: create && !createNew,
    exclusive: createNew,
    truncate: truncate && !createNew,
    mode: 0o666,
  });
  return opened.ok ? opened.value : fail(fromHostError(opened.error));
}
