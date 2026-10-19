import { ASYNC_MODULE } from '../../generated/async-imports.ts';
import type { AsyncHandler, ImplementedSymbol } from './types.ts';

/** Handlers that link but throw, for families a later phase implements. */
function notYet<const S extends ImplementedSymbol>(
  symbols: readonly S[],
): { readonly [K in S]: AsyncHandler<K> } {
  const handlers: Record<string, () => never> = {};
  for (const symbol of symbols) {
    handlers[symbol] = () => {
      throw new Error(`${ASYNC_MODULE}.${symbol} is not implemented yet`);
    };
  }
  // Every handler only throws, so it fits any signature.
  return handlers as unknown as { readonly [K in S]: AsyncHandler<K> };
}

/** TLS connections (P4). */
export const tls = notYet([
  'tls/connection/accept',
  'tls/connection/add_root_certificate',
  'tls/connection/bytes_read',
  'tls/connection/bytes_to_write',
  'tls/connection/connect',
  'tls/connection/free',
  'tls/connection/new',
  'tls/connection/peer_certificate',
  'tls/connection/read_plain',
  'tls/connection/server_endpoint_channel_binding',
  'tls/connection/set_client',
  'tls/connection/set_server_files',
  'tls/connection/set_server_pfx',
  'tls/connection/shutdown',
  'tls/connection/take_error',
  'tls/connection/unique_channel_binding',
  'tls/connection/wants_read',
  'tls/connection/wants_write',
  'tls/connection/write_plain',
  'tls/error/take_global',
]);

/** Child processes, argv/env blocks and the legacy sigwait Job (P5). */
export const processes = notYet([
  'process/allocate_env_block',
  'process/argv_array_add_encoded_entry/unix',
  'process/argv_array_add_entry/unix',
  'process/env_add_entry',
  'process/env_block_add_entry',
  'process/env_block_length',
  'process/free_argv',
  'process/free_env',
  'process/get_curr_env',
  'process/get_process_result',
  'process/kill',
  'process/make_argv_array/unix',
  'process/make_env',
  'process/open_pid_handle',
  'process/terminate',
  'process/write_env_block',
  'thread_pool/make_spawn_job/unix',
  'thread_pool/spawn_job/unix',
  'thread_pool/spawn_job/set_cwd',
  'thread_pool/spawn_job_get_result_handle',
  'thread_pool/get_spawn_job_result_handle',
  'thread_pool/make_wait_for_process_job',
  'thread_pool/make_sigwait_job',
]);
