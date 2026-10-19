/**
 * Access to the guest's exported linear memory.
 *
 * Views are created per access from `memory.buffer`, because `memory.grow` (and a
 * suspension followed by growth) detaches earlier buffers. Out-of-range access
 * throws `GuestFault`; each ABI family decides how a fault surfaces to the guest.
 */
export class GuestFault extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'GuestFault';
  }
}

export class GuestMemory {
  #memory: WebAssembly.Memory | undefined;

  /** Called once after instantiation if the module exports `memory`. */
  bind(memory: WebAssembly.Memory): void {
    this.#memory = memory;
  }

  get bound(): boolean {
    return this.#memory !== undefined;
  }

  #buffer(): ArrayBuffer {
    if (this.#memory === undefined) {
      throw new GuestFault('guest memory is not bound');
    }
    return this.#memory.buffer;
  }

  #check(ptr: number, len: number, size: number): void {
    if (
      !Number.isInteger(ptr) ||
      !Number.isInteger(len) ||
      ptr < 0 ||
      len < 0 ||
      ptr + len > size
    ) {
      throw new GuestFault(`guest range ${ptr}+${len} is outside memory of ${size} bytes`);
    }
  }

  /** A view valid only until the guest runs again. Copy if the bytes must outlive the call. */
  view(ptr: number, len: number): Uint8Array {
    const buffer = this.#buffer();
    this.#check(ptr, len, buffer.byteLength);
    return new Uint8Array(buffer, ptr, len);
  }

  copyOut(ptr: number, len: number): Uint8Array {
    return this.view(ptr, len).slice();
  }

  write(ptr: number, bytes: Uint8Array): void {
    this.view(ptr, bytes.length).set(bytes);
  }

  #data(ptr: number, len: number): DataView {
    const buffer = this.#buffer();
    this.#check(ptr, len, buffer.byteLength);
    return new DataView(buffer, ptr, len);
  }

  u8(ptr: number): number {
    return this.#data(ptr, 1).getUint8(0);
  }
  u16(ptr: number): number {
    return this.#data(ptr, 2).getUint16(0, true);
  }
  u32(ptr: number): number {
    return this.#data(ptr, 4).getUint32(0, true);
  }
  u64(ptr: number): bigint {
    return this.#data(ptr, 8).getBigUint64(0, true);
  }
  setU8(ptr: number, v: number): void {
    this.#data(ptr, 1).setUint8(0, v);
  }
  setU16(ptr: number, v: number): void {
    this.#data(ptr, 2).setUint16(0, v, true);
  }
  setU32(ptr: number, v: number): void {
    this.#data(ptr, 4).setUint32(0, v, true);
  }
  setU64(ptr: number, v: bigint): void {
    this.#data(ptr, 8).setBigUint64(0, v, true);
  }
  setI64(ptr: number, v: bigint): void {
    this.#data(ptr, 8).setBigInt64(0, v, true);
  }

  /** Reads `len` UTF-16 code units (MoonBit string layout). */
  utf16(ptr: number, len: number): string {
    const bytes = this.view(ptr, len * 2);
    let s = '';
    for (let i = 0; i < len; i++) {
      s += String.fromCharCode((bytes[2 * i] ?? 0) | ((bytes[2 * i + 1] ?? 0) << 8));
    }
    return s;
  }
}
