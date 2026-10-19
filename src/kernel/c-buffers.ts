import { err, ok, type Result } from '../ports/result.ts';
import { type AsyncError, BADF } from './errors.ts';
import { type Handle, Handles, type HostKeys, NULL_HANDLE } from './handles.ts';

/** A host buffer; `leased` while a Job owns its bytes (moonrun `HostCBuffer`). */
type CBuffer =
  | { readonly state: 'available'; readonly bytes: Uint8Array }
  | { readonly state: 'leased' };

/** Host Buffers named by c_buffer handles (os strings, temporary paths, readdir buffers). */
export class CBuffers {
  readonly #buffers: Handles<CBuffer>;

  constructor(keys: HostKeys) {
    this.#buffers = new Handles(keys, 'c-buffer');
  }

  insert(bytes: Uint8Array): Handle {
    return this.#buffers.insert({ state: 'available', bytes });
  }

  /** The bytes of a whole buffer entry; interior or raw pointers are never handles. */
  get(handle: Handle): Result<Uint8Array, AsyncError> {
    const buffer = this.#buffers.get(handle);
    return buffer?.state === 'available' ? ok(buffer.bytes) : err(BADF);
  }

  /** Frees a buffer; freeing the null handle is a no-op. */
  free(handle: Handle): Result<void, AsyncError> {
    if (handle === NULL_HANDLE) {
      return ok(undefined);
    }
    return this.#buffers.remove(handle) === undefined ? err(BADF) : ok(undefined);
  }

  /** Moves the bytes to a Job; the handle stays reserved until {@link restore}. */
  lease(handle: Handle): Result<Uint8Array, AsyncError> {
    const buffer = this.#buffers.get(handle);
    if (buffer?.state !== 'available') {
      return err(BADF);
    }
    this.#buffers.set(handle, { state: 'leased' });
    return ok(buffer.bytes);
  }

  /** Returns leased bytes, unless the handle was freed (or reused) meanwhile. */
  restore(handle: Handle, bytes: Uint8Array): void {
    if (this.#buffers.get(handle)?.state === 'leased') {
      this.#buffers.set(handle, { state: 'available', bytes });
    }
  }

  get size(): number {
    return this.#buffers.size;
  }
}
