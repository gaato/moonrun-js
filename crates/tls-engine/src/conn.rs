//! One TLS connection driven through moonrun's contract
//! (`crates/moonrun/src/async_host/tls/openssl.rs` at 748b63c): every call
//! receives the encrypted input and output slices, then reports
//! `bytes_read`, `bytes_to_write`, `wants_read` and `wants_write`.
//!
//! rustls' unbuffered API decrypts and joins handshake fragments in place
//! and keeps that progress across calls, so ciphertext cannot be re-read
//! from the guest's untouched buffer each time. All input handed to a call
//! that needs it is therefore moved into `incoming` (`bytes_read` = input
//! length). Handshake/alert records that did not fit into the output slice
//! wait in `outgoing`; application data is only accepted when its records fit
//! into the output slice, so a successful `write_plain` never leaves
//! ciphertext behind (as with OpenSSL).

use rustls::client::{ClientConnectionData, UnbufferedClientConnection};
use rustls::pki_types::CertificateDer;
use rustls::server::{ServerConnectionData, UnbufferedServerConnection};
use rustls::unbuffered::{
    ConnectionState, EncodeError, EncodeTlsData, EncryptError, InsufficientSizeError,
    UnbufferedStatus, WriteTraffic,
};
use rustls::{CommonState, Error};

use crate::der;
use crate::provider::take_observed_finished;

pub const SUCCESS: i32 = 0;
pub const ERROR: i32 = -1;
pub const CLOSED: i32 = -2;
pub const WOULD_BLOCK: i32 = -3;
pub const RENEGOTIATION: i32 = -4;

/// `TlsState` returned by connect/accept (`tls/mod.rs:46-77`).
const STATE_COMPLETED: i32 = 0;
const STATE_WANT_READ: i32 = 1;
const STATE_WANT_WRITE: i32 = 2;
const STATE_ERROR: i32 = 3;
const STATE_EOF: i32 = 4;
const STATE_RENEGOTIATION: i32 = 5;

trait Process {
    type Data;
    fn process<'c, 'i>(
        &'c mut self,
        incoming: &'i mut [u8],
    ) -> UnbufferedStatus<'c, 'i, Self::Data>;
    fn common(&self) -> &CommonState;
}

impl Process for UnbufferedClientConnection {
    type Data = ClientConnectionData;
    fn process<'c, 'i>(
        &'c mut self,
        incoming: &'i mut [u8],
    ) -> UnbufferedStatus<'c, 'i, Self::Data> {
        self.process_tls_records(incoming)
    }
    fn common(&self) -> &CommonState {
        self
    }
}

impl Process for UnbufferedServerConnection {
    type Data = ServerConnectionData;
    fn process<'c, 'i>(
        &'c mut self,
        incoming: &'i mut [u8],
    ) -> UnbufferedStatus<'c, 'i, Self::Data> {
        self.process_tls_records(incoming)
    }
    fn common(&self) -> &CommonState {
        self
    }
}

pub enum Side {
    Client(Box<UnbufferedClientConnection>),
    Server(Box<UnbufferedServerConnection>, Vec<u8>),
}

/// What to do once the connection reaches `WriteTraffic`.
enum Action<'a> {
    None,
    Encrypt {
        src: &'a [u8],
        out: &'a mut [u8],
        accepted: usize,
        written: usize,
    },
    CloseNotify,
}

enum Stop {
    /// More ciphertext is needed (or nothing else to do while handshaking).
    NeedInput,
    /// Handshake done and nothing pending; `WriteTraffic` was reached.
    Idle,
    /// Application data was decrypted into `plain`.
    GotPlain,
    /// Both sides sent close_notify.
    Closed,
}

struct Buffers<'a> {
    incoming: &'a mut Vec<u8>,
    outgoing: &'a mut Vec<u8>,
    plain: &'a mut Vec<u8>,
    peer_closed: &'a mut bool,
}

fn encode<D>(state: &mut EncodeTlsData<'_, D>, outgoing: &mut Vec<u8>) -> Result<(), Error> {
    let required = match state.encode(&mut []) {
        Ok(_) => return Ok(()),
        Err(EncodeError::InsufficientSize(InsufficientSizeError { required_size })) => {
            required_size
        }
        Err(error) => return Err(Error::General(format!("{error:?}"))),
    };
    let start = outgoing.len();
    outgoing.resize(start + required, 0);
    match state.encode(&mut outgoing[start..]) {
        Ok(written) => {
            outgoing.truncate(start + written);
            Ok(())
        }
        Err(error) => {
            outgoing.truncate(start);
            Err(Error::General(format!("{error:?}")))
        }
    }
}

fn write_traffic<D>(
    traffic: &mut WriteTraffic<'_, D>,
    action: &mut Action<'_>,
    outgoing: &mut Vec<u8>,
) -> Result<(), Error> {
    match action {
        Action::None => Ok(()),
        Action::CloseNotify => {
            let required = match traffic.queue_close_notify(&mut []) {
                Ok(_) => return Ok(()),
                Err(EncryptError::InsufficientSize(InsufficientSizeError { required_size })) => {
                    required_size
                }
                Err(EncryptError::EncryptExhausted) => return Err(Error::EncryptError),
            };
            let start = outgoing.len();
            outgoing.resize(start + required, 0);
            match traffic.queue_close_notify(&mut outgoing[start..]) {
                Ok(written) => {
                    outgoing.truncate(start + written);
                    Ok(())
                }
                Err(_) => {
                    outgoing.truncate(start);
                    Err(Error::EncryptError)
                }
            }
        }
        Action::Encrypt {
            src,
            out,
            accepted,
            written,
        } => {
            if !outgoing.is_empty() {
                // A record queued on the way (e.g. a key update reply) must go
                // out first; the caller flushes and the guest retries.
                return Ok(());
            }
            let space = out.len();
            let mut len = src.len().min(space);
            while len > 0 {
                match traffic.encrypt(&src[..len], out) {
                    Ok(n) => {
                        *accepted = len;
                        *written = n;
                        return Ok(());
                    }
                    Err(EncryptError::InsufficientSize(InsufficientSizeError {
                        required_size,
                    })) => {
                        len = len.saturating_sub(required_size.saturating_sub(space).max(1));
                    }
                    Err(EncryptError::EncryptExhausted) => return Err(Error::EncryptError),
                }
            }
            Ok(())
        }
    }
}

/// Runs the unbuffered state machine until it needs the caller.
fn step<P: Process>(
    conn: &mut P,
    b: &mut Buffers<'_>,
    stop_on_plain: bool,
    action: &mut Action<'_>,
) -> Result<Stop, Error> {
    loop {
        let UnbufferedStatus { discard, state } = conn.process(b.incoming.as_mut_slice());
        let outcome: Result<Option<Stop>, Error> = match state {
            Err(error) => Err(error),
            Ok(ConnectionState::ReadTraffic(mut traffic)) => {
                let mut outcome = Ok(if stop_on_plain {
                    Some(Stop::GotPlain)
                } else {
                    None
                });
                while let Some(record) = traffic.next_record() {
                    match record {
                        Ok(record) => b.plain.extend_from_slice(record.payload),
                        Err(error) => {
                            outcome = Err(error);
                            break;
                        }
                    }
                }
                outcome
            }
            Ok(ConnectionState::EncodeTlsData(mut state)) => {
                encode(&mut state, b.outgoing).map(|()| None)
            }
            Ok(ConnectionState::TransmitTlsData(state)) => {
                // The records are in `outgoing`, which this engine owns.
                state.done();
                Ok(None)
            }
            Ok(ConnectionState::BlockedHandshake) => Ok(Some(Stop::NeedInput)),
            Ok(ConnectionState::WriteTraffic(mut traffic)) => {
                // One action per step: it returns right after.
                write_traffic(&mut traffic, action, b.outgoing).map(|()| Some(Stop::Idle))
            }
            Ok(ConnectionState::PeerClosed) => {
                *b.peer_closed = true;
                Ok(None)
            }
            Ok(ConnectionState::Closed) => {
                *b.peer_closed = true;
                Ok(Some(Stop::Closed))
            }
            Ok(_) => Err(Error::General("unexpected TLS early data".to_string())),
        };
        b.incoming.drain(..discard);
        match outcome {
            Err(error) => return Err(error),
            Ok(Some(stop)) => return Ok(stop),
            Ok(None) => {}
        }
    }
}

/// After a fatal error rustls queues an alert; move it to `outgoing` so the
/// peer sees it (OpenSSL writes its alert before failing too).
/// The connection's own `incoming` must be passed: rustls' handshake joiner
/// keeps ranges into it.
fn collect_alert<P: Process>(conn: &mut P, incoming: &mut Vec<u8>, outgoing: &mut Vec<u8>) {
    for _ in 0..4 {
        let UnbufferedStatus { discard, state } = conn.process(incoming.as_mut_slice());
        let more = match state {
            Ok(ConnectionState::EncodeTlsData(mut state)) => encode(&mut state, outgoing).is_ok(),
            Ok(ConnectionState::TransmitTlsData(state)) => {
                state.done();
                true
            }
            _ => false,
        };
        incoming.drain(..discard);
        if !more {
            return;
        }
    }
}

pub struct Tls {
    side: Side,
    incoming: Vec<u8>,
    outgoing: Vec<u8>,
    plain: Vec<u8>,
    plain_pos: usize,
    peer_closed: bool,
    /// Set by the first connect/accept (OpenSSL creates its stream then).
    started: bool,
    failed: Option<String>,
    shutdown_started: bool,
    shutdown_complete: bool,
    last_error: Option<String>,
    want_read: bool,
    want_write: bool,
    bytes_read: usize,
    bytes_to_write: usize,
    finished_candidate: Option<Vec<u8>>,
}

macro_rules! with_conn {
    ($side:expr, $conn:ident => $body:expr) => {
        match $side {
            Side::Client($conn) => $body,
            Side::Server($conn, _) => $body,
        }
    };
}

impl Tls {
    pub fn new(side: Side) -> Self {
        Self {
            side,
            incoming: Vec::new(),
            outgoing: Vec::new(),
            plain: Vec::new(),
            plain_pos: 0,
            peer_closed: false,
            started: false,
            failed: None,
            shutdown_started: false,
            shutdown_complete: false,
            last_error: None,
            want_read: false,
            // openssl.rs:158 initializes `last_want_write` to true.
            want_write: true,
            bytes_read: 0,
            bytes_to_write: 0,
            finished_candidate: None,
        }
    }

    fn is_client(&self) -> bool {
        matches!(self.side, Side::Client(_))
    }

    fn common(&self) -> &CommonState {
        with_conn!(&self.side, conn => conn.common())
    }

    fn handshaking(&self) -> bool {
        self.common().is_handshaking()
    }

    fn error(&mut self, message: String) -> i32 {
        self.last_error = Some(message);
        ERROR
    }

    fn fail(&mut self, context: &str, error: &Error) -> i32 {
        let message = format!("{context}: {error}");
        with_conn!(&mut self.side, conn => collect_alert(conn.as_mut(), &mut self.incoming, &mut self.outgoing));
        self.failed = Some(message.clone());
        self.error(message)
    }

    fn run(
        &mut self,
        input: &[u8],
        stop_on_plain: bool,
        action: &mut Action<'_>,
    ) -> Result<Stop, Error> {
        self.incoming.extend_from_slice(input);
        self.bytes_read += input.len();
        let _ = take_observed_finished();
        let mut buffers = Buffers {
            incoming: &mut self.incoming,
            outgoing: &mut self.outgoing,
            plain: &mut self.plain,
            peer_closed: &mut self.peer_closed,
        };
        let result = with_conn!(&mut self.side, conn => step(conn.as_mut(), &mut buffers, stop_on_plain, action));
        if let Some(finished) = take_observed_finished() {
            self.finished_candidate = Some(finished);
        }
        result
    }

    /// Moves pending ciphertext into the guest's output slice.
    fn flush(&mut self, output: &mut [u8]) {
        let start = self.bytes_to_write;
        let n = self.outgoing.len().min(output.len().saturating_sub(start));
        output[start..start + n].copy_from_slice(&self.outgoing[..n]);
        self.outgoing.drain(..n);
        self.bytes_to_write += n;
    }

    fn pending(&self) -> bool {
        !self.outgoing.is_empty()
    }

    fn begin(&mut self) {
        self.bytes_read = 0;
        self.bytes_to_write = 0;
    }

    /// `with_scoped_io` (openssl.rs:296-300): output produced on a would-block
    /// or renegotiation status always reports `wants_write`.
    fn finish(&mut self, status: i32) -> i32 {
        if self.bytes_to_write > 0 && (status == WOULD_BLOCK || status == RENEGOTIATION) {
            self.want_write = true;
        }
        status
    }

    /// `TlsState::from_status` (tls/mod.rs:62-76).
    fn to_state(&self, status: i32) -> i32 {
        match status {
            SUCCESS => STATE_COMPLETED,
            WOULD_BLOCK if self.want_write => STATE_WANT_WRITE,
            WOULD_BLOCK => STATE_WANT_READ,
            CLOSED => STATE_EOF,
            RENEGOTIATION => STATE_RENEGOTIATION,
            _ => STATE_ERROR,
        }
    }

    pub fn connect(&mut self, input: &[u8], output: &mut [u8]) -> i32 {
        self.begin();
        if !self.is_client() {
            let status = self.error("TLS connect requires a client handle".to_string());
            return self.to_state(status);
        }
        let status = self.advance(input, output);
        self.to_state(status)
    }

    pub fn accept(&mut self, input: &[u8], output: &mut [u8]) -> i32 {
        self.begin();
        if self.is_client() {
            let status = self.error("TLS accept requires a server handle".to_string());
            return self.to_state(status);
        }
        let status = self.advance(input, output);
        self.to_state(status)
    }

    fn advance(&mut self, input: &[u8], output: &mut [u8]) -> i32 {
        self.started = true;
        let status = if self.shutdown_started {
            self.advance_shutdown(output)
        } else {
            self.advance_handshake(input, output)
        };
        self.finish(status)
    }

    fn settle_writes(&mut self, output: &mut [u8]) -> i32 {
        self.flush(output);
        self.want_read = false;
        self.want_write = self.pending();
        if self.pending() { WOULD_BLOCK } else { SUCCESS }
    }

    fn advance_handshake(&mut self, input: &[u8], output: &mut [u8]) -> i32 {
        if let Some(message) = self.failed.clone() {
            self.flush(output);
            return self.error(message);
        }
        if !self.handshaking() {
            return self.settle_writes(output);
        }
        let result = self.run(input, false, &mut Action::None);
        if let Err(error) = result {
            let status = self.fail("TLS handshake failed", &error);
            self.flush(output);
            return status;
        }
        self.flush(output);
        if !self.handshaking() {
            self.want_read = false;
            self.want_write = self.pending();
            return if self.pending() { WOULD_BLOCK } else { SUCCESS };
        }
        if self.pending() {
            self.want_read = false;
            self.want_write = true;
        } else {
            self.want_read = true;
            self.want_write = false;
        }
        WOULD_BLOCK
    }

    fn advance_shutdown(&mut self, output: &mut [u8]) -> i32 {
        if self.shutdown_complete {
            return self.settle_writes(output);
        }
        if let Some(message) = self.failed.clone() {
            return self.error(message);
        }
        if self.handshaking() {
            return self.error("TLS shutdown failed: shutdown while in init".to_string());
        }
        match self.run(&[], false, &mut Action::CloseNotify) {
            Ok(_) => {
                self.shutdown_complete = true;
                self.settle_writes(output)
            }
            Err(error) => {
                let status = self.fail("TLS shutdown failed", &error);
                self.flush(output);
                status
            }
        }
    }

    pub fn shutdown(&mut self) -> i32 {
        self.shutdown_started = true;
        SUCCESS
    }

    fn take_plain(&mut self, dst: &mut [u8]) -> usize {
        let available = &self.plain[self.plain_pos..];
        let n = available.len().min(dst.len());
        dst[..n].copy_from_slice(&available[..n]);
        self.plain_pos += n;
        if self.plain_pos == self.plain.len() {
            self.plain.clear();
            self.plain_pos = 0;
        }
        n
    }

    pub fn read_plain(&mut self, input: &[u8], dst: &mut [u8], output: &mut [u8]) -> i32 {
        self.begin();
        let status = self.read_plain_inner(input, dst, output);
        self.finish(status)
    }

    fn read_plain_inner(&mut self, input: &[u8], dst: &mut [u8], output: &mut [u8]) -> i32 {
        if dst.is_empty() {
            return 0;
        }
        if self.handshaking() {
            self.want_read = !self.pending();
            self.want_write = self.pending();
            return RENEGOTIATION;
        }
        if self.plain_pos == self.plain.len() {
            if let Some(message) = self.failed.clone() {
                self.flush(output);
                return self.error(message);
            }
            if !self.peer_closed
                && let Err(error) = self.run(input, true, &mut Action::None)
            {
                let status = self.fail("TLS plaintext read failed", &error);
                self.flush(output);
                return status;
            }
        }
        self.flush(output);
        if self.plain_pos < self.plain.len() {
            let n = self.take_plain(dst);
            self.want_read = false;
            self.want_write = self.pending();
            return i32::try_from(n).unwrap_or(i32::MAX);
        }
        if self.peer_closed {
            self.want_read = false;
            self.want_write = self.pending();
            return CLOSED;
        }
        self.want_read = true;
        self.want_write = self.pending();
        WOULD_BLOCK
    }

    pub fn write_plain(&mut self, src: &[u8], output: &mut [u8]) -> i32 {
        self.begin();
        let status = self.write_plain_inner(src, output);
        self.finish(status)
    }

    fn write_plain_inner(&mut self, src: &[u8], output: &mut [u8]) -> i32 {
        if src.is_empty() {
            return 0;
        }
        if self.shutdown_started {
            self.want_read = false;
            self.want_write = self.pending();
            return CLOSED;
        }
        if self.handshaking() {
            self.want_read = false;
            self.want_write = self.pending();
            return RENEGOTIATION;
        }
        if let Some(message) = self.failed.clone() {
            return self.error(message);
        }
        self.flush(output);
        if self.pending() {
            self.want_read = false;
            self.want_write = true;
            return WOULD_BLOCK;
        }
        let start = self.bytes_to_write;
        let mut action = Action::Encrypt {
            src,
            out: &mut output[start..],
            accepted: 0,
            written: 0,
        };
        let result = self.run(&[], false, &mut action);
        let (accepted, written) = match action {
            Action::Encrypt {
                accepted, written, ..
            } => (accepted, written),
            _ => (0, 0),
        };
        self.bytes_to_write += written;
        if let Err(error) = result {
            let status = self.fail("TLS plaintext write failed", &error);
            self.flush(output);
            return status;
        }
        self.flush(output);
        self.want_read = false;
        self.want_write = self.pending();
        if accepted == 0 {
            self.want_write = true;
            return WOULD_BLOCK;
        }
        i32::try_from(accepted).unwrap_or(i32::MAX)
    }

    pub fn bytes_read(&self) -> usize {
        self.bytes_read
    }

    pub fn bytes_to_write(&self) -> usize {
        self.bytes_to_write
    }

    pub fn wants_read(&self) -> bool {
        self.want_read
    }

    pub fn wants_write(&self) -> bool {
        self.want_write
    }

    pub fn take_error(&mut self) -> Option<String> {
        self.last_error.take()
    }

    pub fn set_error(&mut self, message: String) {
        self.last_error = Some(message);
    }

    /// `peer_certificate_der` (openssl.rs:433-446): `None` before the first
    /// connect/accept and when the peer sent none (servers never request one).
    pub fn peer_certificate(&self) -> Option<Vec<u8>> {
        if !self.started {
            return None;
        }
        self.common()
            .peer_certificates()
            .and_then(|certs| certs.first())
            .map(|cert| cert.to_vec())
    }

    /// Client Finished verify_data once the handshake is complete
    /// (OpenSSL's `SSL_get_finished` / `SSL_get_peer_finished`).
    pub fn unique_channel_binding(&self) -> Option<Vec<u8>> {
        if !self.started || self.handshaking() {
            return None;
        }
        self.finished_candidate.clone()
    }

    /// RFC 5929 tls-server-endpoint over the server certificate
    /// (openssl.rs:471-488, 771-787).
    pub fn server_endpoint_channel_binding(&self) -> Result<Option<Vec<u8>>, String> {
        if !self.started {
            return Ok(None);
        }
        let cert: Option<Vec<u8>> = match &self.side {
            Side::Client(_) => self.peer_certificate(),
            Side::Server(_, own) => Some(own.clone()),
        };
        let Some(cert) = cert else {
            return Ok(None);
        };
        let unavailable = || "tls-server-endpoint channel binding unavailable".to_string();
        let info = der::parse_certificate(&cert).ok_or_else(unavailable)?;
        let digest =
            der::server_endpoint_digest(info.signature_algorithm).ok_or_else(unavailable)?;
        Ok(Some(ring::digest::digest(digest, &cert).as_ref().to_vec()))
    }
}

pub fn server_side(conn: UnbufferedServerConnection, leaf: &CertificateDer<'_>) -> Side {
    Side::Server(Box::new(conn), leaf.to_vec())
}

pub fn client_side(conn: UnbufferedClientConnection) -> Side {
    Side::Client(Box::new(conn))
}
