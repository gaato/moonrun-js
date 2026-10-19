// `tls/connection/*` and `tls/error/take_global` (moonrun `async_api/tls.rs` and the
// TLS part of `async_host/mod.rs`) over the run's TlsDomain. See
// src/domains/tls/CONTRACT.md for the handle and data-path conventions.
import { TlsDomain, type TlsSession } from '../../domains/tls/index.ts';
import { BADF, FAULT, INVAL } from '../../kernel/errors.ts';
import { type Handle, Handles, NULL_HANDLE } from '../../kernel/handles.ts';
import type { FilePort } from '../../ports/files.ts';
import { err, type HostError, hostError, ok, type Result } from '../../ports/result.ts';
import type { RunContext } from '../context.ts';
import { rustIoErrorText } from '../errno.ts';
import type { GuestMemory } from '../memory.ts';
import { type AsyncEnv, AsyncFailure, debugOf, handle } from './env.ts';
import { cString } from './guest-data.ts';
import type { HandlerGroup } from './types.ts';

/** moonrun `read_guest_string` / `read_guest_os_path` on Unix: UTF-16, lone surrogates become U+FFFD. */
function readGuestUtf16Lossy(memory: GuestMemory, ptr: number, len: number): string {
  if (len !== 0 && ptr % 2 !== 0) {
    throw new AsyncFailure(FAULT);
  }
  return memory.utf16(ptr, len).toWellFormed();
}

/** moonrun `guest_range` + `guest_offset`: `[ptr + offset, ptr + offset + len)` inside memory. */
interface Span {
  readonly start: number;
  readonly len: number;
}

function overlaps(a: Span, b: Span): boolean {
  return a.start < b.start + b.len && b.start < a.start + a.len;
}

/**
 * Views of disjoint guest ranges (moonrun `read_guest_input_output_mut` /
 * `read_guest_buffers3_mut`): every range is bounds-checked, then any overlap is a Fault.
 */
function disjointViews(memory: GuestMemory, spans: readonly Span[]): Uint8Array[] {
  const views = spans.map((s) => memory.view(s.start, s.len));
  for (let i = 0; i < spans.length; i++) {
    for (let j = i + 1; j < spans.length; j++) {
      if (overlaps(spans[i] as Span, spans[j] as Span)) {
        throw new AsyncFailure(FAULT);
      }
    }
  }
  return views;
}

const READ_CHUNK = 64 * 1024;

/** A whole host file through the FilePort (relative paths resolve against the run's cwd). */
function readWholeFile(files: FilePort, path: string): Result<Uint8Array, HostError> {
  const opened = files.open(path, {
    access: 'read',
    append: false,
    create: false,
    exclusive: false,
    truncate: false,
  });
  if (!opened.ok) {
    return err(withText(opened.error));
  }
  const fd = opened.value;
  try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const chunk = new Uint8Array(READ_CHUNK);
      const n = files.read(fd, chunk);
      if (!n.ok) {
        return err(withText(n.error));
      }
      if (n.value === 0) {
        break;
      }
      chunks.push(chunk.subarray(0, n.value));
      total += n.value;
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return ok(out);
  } finally {
    files.close(fd);
  }
}

function withText(error: HostError): HostError {
  return hostError(error.code, rustIoErrorText(error));
}

/** The TLS state of one run: the domain (engine instantiated on first use) and its sessions. */
function tlsDomain(ctx: RunContext): TlsDomain {
  const host = ctx.host;
  return new TlsDomain({
    engineModule: () => {
      const module = host.components.tlsEngine();
      return module.ok ? ok(module.value) : err(module.error.message ?? module.error.code);
    },
    clock: host.clock,
    random: host.random,
    trustStore: host.trustStore,
    readFile: (path) => readWholeFile(host.files, path),
    authorizeRead: (path) => authorizeRead(ctx, path),
  });
}

/** `HostFs::authorize_read`; the error is moonrun's `{error:?}` of the `AsyncHostError`. */
function authorizeRead(ctx: RunContext, path: string): Result<void, string> {
  const policy = ctx.policy();
  if (!policy.enforced) {
    return ok(undefined);
  }
  const denied = policy.authorizeRead(path);
  return denied === undefined ? ok(undefined) : err(debugOf(denied));
}

/** A session's `Inval` (the only host error TlsSession returns) as the import's failure. */
function unwrapSession<T>(result: Result<T, HostError>): T {
  if (!result.ok) {
    throw new AsyncFailure(result.error.code === 'EINVAL' ? INVAL : BADF);
  }
  return result.value;
}

export function tls(env: AsyncEnv) {
  const { kernel, memory, ctx } = env;
  const sessions = new Handles<TlsSession>(kernel.keys, 'tls-connection');
  kernel.tlsConnections = sessions;
  let domain: TlsDomain | undefined;
  const getDomain = (): TlsDomain => {
    domain ??= tlsDomain(ctx);
    return domain;
  };
  /** moonrun `with_tls_handle_mut`: an unknown handle is `Badf`. */
  const session = (raw: bigint): TlsSession => {
    const found = sessions.get(handle(raw));
    if (found === undefined) {
      throw new AsyncFailure(BADF);
    }
    return found;
  };
  const buffer = (bytes: Uint8Array | null): Handle =>
    bytes === null ? NULL_HANDLE : kernel.cBuffers.insert(bytes);
  const message = (text: string): Handle => kernel.cBuffers.insert(cString(text));
  /** The (input, output) slices of connect / accept. */
  const handshakeViews = (
    inBuf: number,
    inOff: number,
    inLen: number,
    outBuf: number,
    outOff: number,
    outLen: number,
  ): [Uint8Array, Uint8Array] => {
    const [input, output] = disjointViews(memory, [
      { start: inBuf + inOff, len: inLen },
      { start: outBuf + outOff, len: outLen },
    ]);
    return [input as Uint8Array, output as Uint8Array];
  };
  /** The (input, output, plain) slices of read_plain / write_plain. */
  const plainViews = (
    inBuf: number,
    inOff: number,
    inLen: number,
    outBuf: number,
    outOff: number,
    outLen: number,
    plainBuf: number,
    plainOff: number,
    plainLen: number,
  ): [Uint8Array, Uint8Array, Uint8Array] => {
    const [input, output, plain] = disjointViews(memory, [
      { start: inBuf + inOff, len: inLen },
      { start: outBuf + outOff, len: outLen },
      { start: plainBuf + plainOff, len: plainLen },
    ]);
    return [input as Uint8Array, output as Uint8Array, plain as Uint8Array];
  };
  return {
    'tls/connection/new': () => sessions.insert(getDomain().create()),
    'tls/connection/set_client': (tlsHandle, host, hostLen, sni, trust) => {
      const hostname = readGuestUtf16Lossy(memory, host, hostLen);
      if (trust !== 0 && trust !== 1 && trust !== 2) {
        throw new AsyncFailure(INVAL);
      }
      return unwrapSession(session(tlsHandle).setClient(hostname, sni !== 0, trust));
    },
    'tls/connection/add_root_certificate': (tlsHandle, root, rootLen) => {
      const der = memory.view(root, rootLen);
      return unwrapSession(session(tlsHandle).addRootCertificate(der));
    },
    'tls/connection/set_server_files': (
      tlsHandle,
      keyFile,
      keyFileLen,
      keyType,
      certFile,
      certFileLen,
      certType,
    ) => {
      const privateKeyFile = readGuestUtf16Lossy(memory, keyFile, keyFileLen);
      const certificateFile = readGuestUtf16Lossy(memory, certFile, certFileLen);
      if ((keyType !== 1 && keyType !== 2) || (certType !== 1 && certType !== 2)) {
        throw new AsyncFailure(INVAL);
      }
      const found = sessions.get(handle(tlsHandle));
      if (found === undefined) {
        // moonrun authorizes both files before it looks the handle up (mod.rs:3818-3830).
        for (const path of [privateKeyFile, certificateFile]) {
          if (!authorizeRead(ctx, path).ok) {
            break;
          }
        }
        throw new AsyncFailure(BADF);
      }
      return unwrapSession(
        found.setServerFiles(privateKeyFile, keyType, certificateFile, certType),
      );
    },
    'tls/connection/set_server_pfx': (tlsHandle, pfx, pfxLen) => {
      const content = memory.copyOut(pfx, pfxLen);
      return unwrapSession(session(tlsHandle).setServerPfx(content));
    },
    'tls/connection/free': (tlsHandle) => {
      const h = handle(tlsHandle);
      if (h === NULL_HANDLE) {
        return;
      }
      const removed = sessions.remove(h);
      if (removed === undefined) {
        throw new AsyncFailure(BADF);
      }
      removed.free();
    },
    'tls/connection/take_error': (tlsHandle) => message(session(tlsHandle).takeError()),
    'tls/error/take_global': () => message(getDomain().takeGlobalError()),
    'tls/connection/read_plain': (
      tlsHandle,
      inBuf,
      inOff,
      inLen,
      outBuf,
      outOff,
      outLen,
      plainBuf,
      plainOff,
      plainLen,
    ) => {
      const [input, output, plain] = plainViews(
        inBuf,
        inOff,
        inLen,
        outBuf,
        outOff,
        outLen,
        plainBuf,
        plainOff,
        plainLen,
      );
      return session(tlsHandle).readPlain(input, output, plain);
    },
    'tls/connection/write_plain': (
      tlsHandle,
      inBuf,
      inOff,
      inLen,
      outBuf,
      outOff,
      outLen,
      plainBuf,
      plainOff,
      plainLen,
    ) => {
      const [input, output, plain] = plainViews(
        inBuf,
        inOff,
        inLen,
        outBuf,
        outOff,
        outLen,
        plainBuf,
        plainOff,
        plainLen,
      );
      return session(tlsHandle).writePlain(input, output, plain);
    },
    'tls/connection/connect': (tlsHandle, inBuf, inOff, inLen, outBuf, outOff, outLen) => {
      const [input, output] = handshakeViews(inBuf, inOff, inLen, outBuf, outOff, outLen);
      return session(tlsHandle).connect(input, output);
    },
    'tls/connection/accept': (tlsHandle, inBuf, inOff, inLen, outBuf, outOff, outLen) => {
      const [input, output] = handshakeViews(inBuf, inOff, inLen, outBuf, outOff, outLen);
      return session(tlsHandle).accept(input, output);
    },
    'tls/connection/bytes_read': (tlsHandle) => session(tlsHandle).bytesRead(),
    'tls/connection/bytes_to_write': (tlsHandle) => session(tlsHandle).bytesToWrite(),
    'tls/connection/wants_read': (tlsHandle) => (session(tlsHandle).wantsRead() ? 1 : 0),
    'tls/connection/wants_write': (tlsHandle) => (session(tlsHandle).wantsWrite() ? 1 : 0),
    'tls/connection/shutdown': (tlsHandle) => session(tlsHandle).shutdown(),
    'tls/connection/peer_certificate': (tlsHandle) => buffer(session(tlsHandle).peerCertificate()),
    'tls/connection/unique_channel_binding': (tlsHandle) =>
      buffer(session(tlsHandle).uniqueChannelBinding()),
    'tls/connection/server_endpoint_channel_binding': (tlsHandle) =>
      buffer(session(tlsHandle).serverEndpointChannelBinding()),
  } satisfies HandlerGroup;
}
