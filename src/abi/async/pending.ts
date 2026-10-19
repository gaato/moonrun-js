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

/** Sockets, addresses and name resolution (P3). */
export const network = notYet([
  'socket/accept/unix',
  'socket/addr_copy_ipv6_bytes',
  'socket/addr_get_ipv6_bytes_offset',
  'socket/addr_get_ipv6_scope_id',
  'socket/addr_is_ipv6',
  'socket/addr_is_ipv6_wildcard',
  'socket/addr_is_multicast',
  'socket/addrinfo_addr_size',
  'socket/addrinfo_fill_addr',
  'socket/addrinfo_free',
  'socket/addrinfo_get_next',
  'socket/addrinfo_is_null',
  'socket/allow_reuse_addr',
  'socket/allow_reuse_port',
  'socket/bind',
  'socket/connect/unix',
  'socket/disable_nagle',
  'socket/enable_keepalive',
  'socket/find_ipv6_test_interface',
  'socket/gai_strerror',
  'socket/getsockerr/unix',
  'socket/getsockname',
  'socket/if_indextoname',
  'socket/if_nametoindex',
  'socket/init_ip_addr',
  'socket/init_ipv6_addr',
  'socket/ip_addr_get_ip',
  'socket/ip_addr_get_port',
  'socket/ipv4_addr_size',
  'socket/ipv6_addr_size',
  'socket/join_multicast_group',
  'socket/join_multicast_group_v6',
  'socket/listen',
  'socket/make_tcp_socket',
  'socket/make_udp_socket',
  'socket/recvfrom/unix',
  'socket/sendto/unix',
  'socket/set_ipv6_only',
  'socket/set_multicast_interface',
  'socket/set_multicast_interface_v6',
  'socket/set_multicast_loopback',
  'socket/set_multicast_ttl',
  'socket/udp_client_connect',
  'thread_pool/make_bind_job',
  'thread_pool/make_getaddrinfo_job',
  'thread_pool/get_getaddrinfo_result',
]);

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
