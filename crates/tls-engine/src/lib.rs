//! moonrun-js TLS engine: rustls (ring provider) behind a small C ABI for
//! wasm32-unknown-unknown. The only host imports are `env.now_unix_ms` and
//! `env.random_fill`. The TypeScript wrapper (`src/domains/tls/`) copies
//! guest slices into this module's memory through `tls_alloc`, calls one
//! export per contract operation and copies results back.
//!
//! Variable-size results (error texts, certificates, channel bindings) are
//! left in a single result buffer read through `tls_result_ptr`/`_len`.

mod conn;
mod der;
mod provider;
mod verify;

use std::cell::RefCell;
use std::net::IpAddr;
use std::sync::Arc;

use rustls::client::{Resumption, UnbufferedClientConnection};
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName};
use rustls::server::{
    ClientHello, NoServerSessionStorage, ResolvesServerCert, UnbufferedServerConnection,
};
use rustls::sign::CertifiedKey;
use rustls::{ClientConfig, ServerConfig};

use conn::Tls;
use verify::{NameCheck, Roots, Verifier};

struct Slots<T> {
    items: Vec<Option<T>>,
}

impl<T> Slots<T> {
    const fn new() -> Self {
        Self { items: Vec::new() }
    }

    fn insert(&mut self, value: T) -> u32 {
        let index = match self.items.iter().position(Option::is_none) {
            Some(index) => {
                self.items[index] = Some(value);
                index
            }
            None => {
                self.items.push(Some(value));
                self.items.len() - 1
            }
        };
        u32::try_from(index + 1).unwrap_or(0)
    }

    fn get(&mut self, id: u32) -> &mut T {
        let index = (id as usize).wrapping_sub(1);
        match self.items.get_mut(index).and_then(Option::as_mut) {
            Some(value) => value,
            None => panic!("unknown TLS engine handle"),
        }
    }

    fn remove(&mut self, id: u32) {
        let index = (id as usize).wrapping_sub(1);
        if let Some(slot) = self.items.get_mut(index) {
            *slot = None;
        }
    }
}

thread_local! {
    static CONNECTIONS: RefCell<Slots<Tls>> = const { RefCell::new(Slots::new()) };
    static ROOTS: RefCell<Slots<Arc<Roots>>> = const { RefCell::new(Slots::new()) };
    static RESULT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

fn set_result(bytes: Vec<u8>) {
    RESULT.with(|result| *result.borrow_mut() = bytes);
}

fn with_tls<R>(id: u32, f: impl FnOnce(&mut Tls) -> R) -> R {
    CONNECTIONS.with(|connections| f(connections.borrow_mut().get(id)))
}

/// # Safety
/// `ptr..ptr+len` must be memory previously obtained from `tls_alloc` (or empty).
unsafe fn slice<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    if len == 0 {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(ptr, len) }
    }
}

/// # Safety
/// As [`slice`], and not aliased by another slice passed to the same call.
unsafe fn slice_mut<'a>(ptr: *mut u8, len: usize) -> &'a mut [u8] {
    if len == 0 {
        &mut []
    } else {
        unsafe { std::slice::from_raw_parts_mut(ptr, len) }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn tls_alloc(len: usize) -> *mut u8 {
    let mut buffer = Vec::<u8>::with_capacity(len.max(1));
    let ptr = buffer.as_mut_ptr();
    std::mem::forget(buffer);
    ptr
}

/// # Safety
/// `ptr` must come from `tls_alloc(len)`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tls_dealloc(ptr: *mut u8, len: usize) {
    drop(unsafe { Vec::from_raw_parts(ptr, 0, len.max(1)) });
}

#[unsafe(no_mangle)]
pub extern "C" fn tls_result_ptr() -> *const u8 {
    RESULT.with(|result| result.borrow().as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn tls_result_len() -> usize {
    RESULT.with(|result| result.borrow().len())
}

/// Parses a root list encoded as repeated `[u32 LE length][DER]`.
/// `strict` = 1 fails on the first unparsable entry (custom roots);
/// 0 skips them (system bundles). Returns a store id, or 0 with the error
/// text in the result buffer.
///
/// # Safety
/// The list must be in engine memory.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tls_roots_new(list: *const u8, list_len: usize, strict: i32) -> u32 {
    let mut rest = unsafe { slice(list, list_len) };
    let mut ders = Vec::new();
    while rest.len() >= 4 {
        let len = u32::from_le_bytes([rest[0], rest[1], rest[2], rest[3]]) as usize;
        rest = &rest[4..];
        if rest.len() < len {
            break;
        }
        ders.push(rest[..len].to_vec());
        rest = &rest[len..];
    }
    match Roots::new(ders, strict != 0) {
        Ok(roots) => ROOTS.with(|slots| slots.borrow_mut().insert(Arc::new(roots))),
        Err(message) => {
            set_result(message.into_bytes());
            0
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn tls_roots_free(id: u32) {
    ROOTS.with(|slots| slots.borrow_mut().remove(id));
}

fn pki_ip(ip: IpAddr) -> rustls::pki_types::IpAddr {
    match ip {
        IpAddr::V4(v4) => rustls::pki_types::IpAddr::V4(v4.octets().into()),
        IpAddr::V6(v6) => rustls::pki_types::IpAddr::V6(v6.segments().into()),
    }
}

fn client_config(
    host: &str,
    sni: bool,
    roots: Option<Arc<Roots>>,
) -> Result<(ClientConfig, ServerName<'static>), String> {
    let provider = provider::provider();
    let algorithms = provider.signature_verification_algorithms;
    let ip = host.parse::<IpAddr>().ok();
    let name_check = match (host.is_empty(), ip) {
        (true, _) => NameCheck::Skip,
        (false, Some(ip)) => NameCheck::Ip(ServerName::IpAddress(pki_ip(ip))),
        (false, None) => NameCheck::Dns(host.to_string()),
    };
    // rustls never sends an IP address (or an invalid DNS name) as SNI.
    let server_name = match (ip, ServerName::try_from(host.to_string())) {
        (None, Ok(name @ ServerName::DnsName(_))) => name,
        _ => ServerName::IpAddress(pki_ip(IpAddr::from([0, 0, 0, 0]))),
    };
    let verifier = Verifier::new(roots, name_check, algorithms);
    let mut config = ClientConfig::builder_with_details(provider, Arc::new(provider::HostTime))
        .with_safe_default_protocol_versions()
        .map_err(|error| format!("failed to create TLS client context: {error}"))?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_no_client_auth();
    config.resumption = Resumption::disabled();
    config.enable_sni = sni;
    Ok((config, server_name))
}

/// `TlsConnection::client` (openssl.rs:55-100). `verify` = 0 for trust mode
/// 0; otherwise `roots` is a store from `tls_roots_new`. Returns a
/// connection id, or 0 with the error text in the result buffer.
///
/// # Safety
/// `host` must be UTF-8 bytes in engine memory.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tls_client_new(
    host: *const u8,
    host_len: usize,
    sni: i32,
    verify: i32,
    roots: u32,
) -> u32 {
    let host = String::from_utf8_lossy(unsafe { slice(host, host_len) }).into_owned();
    let roots =
        (verify != 0).then(|| ROOTS.with(|slots| Arc::clone(slots.borrow_mut().get(roots))));
    let created = client_config(&host, sni != 0, roots).and_then(|(config, name)| {
        UnbufferedClientConnection::new(Arc::new(config), name)
            .map_err(|error| format!("failed to create TLS client: {error}"))
    });
    match created {
        Ok(connection) => CONNECTIONS.with(|slots| {
            slots
                .borrow_mut()
                .insert(Tls::new(conn::client_side(connection)))
        }),
        Err(message) => {
            set_result(message.into_bytes());
            0
        }
    }
}

#[derive(Debug)]
struct SingleCert(Arc<CertifiedKey>);

impl ResolvesServerCert for SingleCert {
    fn resolve(&self, _client_hello: ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
        Some(Arc::clone(&self.0))
    }
}

const FILE_TYPE_PEM: i32 = 1;

fn load_chain(bytes: &[u8], file_type: i32) -> Result<Vec<CertificateDer<'static>>, String> {
    if file_type == FILE_TYPE_PEM {
        let chain = CertificateDer::pem_slice_iter(bytes)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("failed to load TLS certificate chain: {error:?}"))?;
        if chain.is_empty() {
            return Err("failed to load TLS certificate chain: no certificate found".to_string());
        }
        Ok(chain)
    } else {
        if der::parse_certificate(bytes).is_none() {
            return Err("failed to load TLS certificate: invalid DER certificate".to_string());
        }
        Ok(vec![CertificateDer::from(bytes.to_vec())])
    }
}

fn load_key(bytes: &[u8], file_type: i32) -> Result<PrivateKeyDer<'static>, String> {
    let key = if file_type == FILE_TYPE_PEM {
        PrivateKeyDer::from_pem_slice(bytes).map_err(|error| format!("{error:?}"))
    } else {
        PrivateKeyDer::try_from(bytes.to_vec()).map_err(|error| error.to_string())
    };
    key.map_err(|error| format!("failed to load TLS private key: {error}"))
}

fn server(cert: &[u8], cert_type: i32, key: &[u8], key_type: i32) -> Result<conn::Side, String> {
    let chain = load_chain(cert, cert_type)?;
    let key = load_key(key, key_type)?;
    let provider = provider::provider();
    let signing_key = provider
        .key_provider
        .load_private_key(key)
        .map_err(|error| format!("failed to load TLS private key: {error}"))?;
    let leaf = chain[0].clone();
    let certified = CertifiedKey::new(chain, signing_key);
    certified
        .keys_match()
        .map_err(|error| format!("failed to load TLS private key: {error}"))?;
    let mut config = ServerConfig::builder_with_details(provider, Arc::new(provider::HostTime))
        .with_safe_default_protocol_versions()
        .map_err(|error| format!("failed to create TLS server context: {error}"))?
        .with_no_client_auth()
        .with_cert_resolver(Arc::new(SingleCert(Arc::new(certified))));
    config.send_tls13_tickets = 0;
    config.session_storage = Arc::new(NoServerSessionStorage {});
    let connection = UnbufferedServerConnection::new(Arc::new(config))
        .map_err(|error| format!("failed to create TLS server: {error}"))?;
    Ok(conn::server_side(connection, &leaf))
}

/// `TlsConnection::server` with file contents already read by the host
/// (openssl.rs:102-145). File types: 1 = PEM, 2 = ASN.1/DER. Returns a
/// connection id, or 0 with the error text in the result buffer.
///
/// # Safety
/// Both buffers must be in engine memory.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tls_server_new(
    cert: *const u8,
    cert_len: usize,
    cert_type: i32,
    key: *const u8,
    key_len: usize,
    key_type: i32,
) -> u32 {
    let (cert, key) = unsafe { (slice(cert, cert_len), slice(key, key_len)) };
    match server(cert, cert_type, key, key_type) {
        Ok(side) => CONNECTIONS.with(|slots| slots.borrow_mut().insert(Tls::new(side))),
        Err(message) => {
            set_result(message.into_bytes());
            0
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn tls_conn_free(id: u32) {
    CONNECTIONS.with(|slots| slots.borrow_mut().remove(id));
}

/// # Safety
/// Disjoint buffers in engine memory.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tls_connect(
    id: u32,
    input: *const u8,
    input_len: usize,
    output: *mut u8,
    output_len: usize,
) -> i32 {
    let (input, output) = unsafe { (slice(input, input_len), slice_mut(output, output_len)) };
    with_tls(id, |tls| tls.connect(input, output))
}

/// # Safety
/// Disjoint buffers in engine memory.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tls_accept(
    id: u32,
    input: *const u8,
    input_len: usize,
    output: *mut u8,
    output_len: usize,
) -> i32 {
    let (input, output) = unsafe { (slice(input, input_len), slice_mut(output, output_len)) };
    with_tls(id, |tls| tls.accept(input, output))
}

/// # Safety
/// Disjoint buffers in engine memory.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tls_read_plain(
    id: u32,
    input: *const u8,
    input_len: usize,
    output: *mut u8,
    output_len: usize,
    plain: *mut u8,
    plain_len: usize,
) -> i32 {
    let (input, output, plain) = unsafe {
        (
            slice(input, input_len),
            slice_mut(output, output_len),
            slice_mut(plain, plain_len),
        )
    };
    with_tls(id, |tls| tls.read_plain(input, plain, output))
}

/// Never consumes input (`bytes_read` stays 0), like `SSL_write` outside renegotiation.
///
/// # Safety
/// Disjoint buffers in engine memory.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tls_write_plain(
    id: u32,
    output: *mut u8,
    output_len: usize,
    plain: *const u8,
    plain_len: usize,
) -> i32 {
    let (output, plain) = unsafe { (slice_mut(output, output_len), slice(plain, plain_len)) };
    with_tls(id, |tls| tls.write_plain(plain, output))
}

#[unsafe(no_mangle)]
pub extern "C" fn tls_bytes_read(id: u32) -> usize {
    with_tls(id, |tls| tls.bytes_read())
}

#[unsafe(no_mangle)]
pub extern "C" fn tls_bytes_to_write(id: u32) -> usize {
    with_tls(id, |tls| tls.bytes_to_write())
}

#[unsafe(no_mangle)]
pub extern "C" fn tls_wants_read(id: u32) -> i32 {
    with_tls(id, |tls| i32::from(tls.wants_read()))
}

#[unsafe(no_mangle)]
pub extern "C" fn tls_wants_write(id: u32) -> i32 {
    with_tls(id, |tls| i32::from(tls.wants_write()))
}

#[unsafe(no_mangle)]
pub extern "C" fn tls_shutdown(id: u32) -> i32 {
    with_tls(id, |tls| tls.shutdown())
}

/// 1 = the error text is in the result buffer, 0 = no pending error.
#[unsafe(no_mangle)]
pub extern "C" fn tls_take_error(id: u32) -> i32 {
    match with_tls(id, Tls::take_error) {
        Some(message) => {
            set_result(message.into_bytes());
            1
        }
        None => 0,
    }
}

fn optional_result(value: Result<Option<Vec<u8>>, String>, id: u32) -> i32 {
    match value {
        Ok(Some(bytes)) => {
            set_result(bytes);
            1
        }
        Ok(None) => 0,
        Err(message) => {
            with_tls(id, |tls| tls.set_error(message));
            -1
        }
    }
}

/// 1 = DER in the result buffer, 0 = none, -1 = error (text via `tls_take_error`).
#[unsafe(no_mangle)]
pub extern "C" fn tls_peer_certificate(id: u32) -> i32 {
    optional_result(Ok(with_tls(id, |tls| tls.peer_certificate())), id)
}

/// 1 = binding in the result buffer, 0 = none, -1 = error.
#[unsafe(no_mangle)]
pub extern "C" fn tls_unique_channel_binding(id: u32) -> i32 {
    optional_result(Ok(with_tls(id, |tls| tls.unique_channel_binding())), id)
}

/// 1 = binding in the result buffer, 0 = none, -1 = error.
#[unsafe(no_mangle)]
pub extern "C" fn tls_server_endpoint_channel_binding(id: u32) -> i32 {
    optional_result(
        with_tls(id, |tls| tls.server_endpoint_channel_binding()),
        id,
    )
}
