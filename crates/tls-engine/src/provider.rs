//! Crypto provider: rustls' ring provider with host randomness and host time,
//! plus thin delegates that observe the client Finished verify_data.
//!
//! moonrun's `unique_channel_binding` returns OpenSSL's `SSL_get_finished`
//! (client) / `SSL_get_peer_finished` (server). Both are the *client*
//! Finished verify_data, for TLS 1.2 and 1.3 alike. rustls does not expose
//! Finished messages, so the suites are wrapped:
//! - TLS 1.3: every Finished is `Hkdf::hmac_sign(finished_key, transcript)`
//!   (`KeySchedule::sign_verify_data`). The last one computed during a
//!   handshake is the client Finished on both sides (the client computes the
//!   expected server Finished first, then its own; the server signs its own,
//!   then checks the client's).
//! - TLS 1.2: verify_data is `Prf::for_secret(.., b"client finished", ..)`.

use std::cell::RefCell;
use std::sync::Arc;

use rustls::SupportedCipherSuite;
use rustls::crypto::hmac::Tag;
use rustls::crypto::tls12::Prf;
use rustls::crypto::tls13::{Hkdf, HkdfExpander, OkmBlock};
use rustls::crypto::{ActiveKeyExchange, CryptoProvider};
use rustls::pki_types::UnixTime;
use rustls::time_provider::TimeProvider;

#[link(wasm_import_module = "env")]
unsafe extern "C" {
    /// Milliseconds since the Unix epoch.
    fn now_unix_ms() -> f64;
    /// Fills `len` bytes at `ptr` with cryptographically secure randomness.
    fn random_fill(ptr: *mut u8, len: usize);
}

fn host_random(buf: &mut [u8]) -> Result<(), getrandom::Error> {
    // SAFETY: the host writes exactly `buf.len()` bytes into our own memory.
    unsafe { random_fill(buf.as_mut_ptr(), buf.len()) };
    Ok(())
}
getrandom::register_custom_getrandom!(host_random);

pub fn now() -> UnixTime {
    // SAFETY: a pure host query.
    let ms = unsafe { now_unix_ms() };
    let ms = if ms.is_finite() && ms > 0.0 {
        ms as u64
    } else {
        0
    };
    UnixTime::since_unix_epoch(core::time::Duration::from_millis(ms))
}

#[derive(Debug)]
pub struct HostTime;

impl TimeProvider for HostTime {
    fn current_time(&self) -> Option<UnixTime> {
        Some(now())
    }
}

thread_local! {
    static OBSERVED_FINISHED: RefCell<Option<Vec<u8>>> = const { RefCell::new(None) };
    static PROVIDER: Arc<CryptoProvider> = Arc::new(build_provider());
}

fn observe(verify_data: &[u8]) {
    OBSERVED_FINISHED.with(|slot| *slot.borrow_mut() = Some(verify_data.to_vec()));
}

/// Takes the last client Finished candidate observed since the previous call.
pub fn take_observed_finished() -> Option<Vec<u8>> {
    OBSERVED_FINISHED.with(|slot| slot.borrow_mut().take())
}

pub fn provider() -> Arc<CryptoProvider> {
    PROVIDER.with(Arc::clone)
}

fn build_provider() -> CryptoProvider {
    let base = rustls::crypto::ring::default_provider();
    let cipher_suites = base
        .cipher_suites
        .iter()
        .map(|suite| wrap_suite(*suite))
        .collect();
    CryptoProvider {
        cipher_suites,
        ..base
    }
}

fn wrap_suite(suite: SupportedCipherSuite) -> SupportedCipherSuite {
    match suite {
        SupportedCipherSuite::Tls13(inner) => {
            let hkdf: &'static ObservingHkdf =
                Box::leak(Box::new(ObservingHkdf(inner.hkdf_provider)));
            SupportedCipherSuite::Tls13(Box::leak(Box::new(rustls::Tls13CipherSuite {
                common: rustls::CipherSuiteCommon {
                    suite: inner.common.suite,
                    hash_provider: inner.common.hash_provider,
                    confidentiality_limit: inner.common.confidentiality_limit,
                },
                hkdf_provider: hkdf,
                aead_alg: inner.aead_alg,
                quic: inner.quic,
            })))
        }
        SupportedCipherSuite::Tls12(inner) => {
            let prf: &'static ObservingPrf = Box::leak(Box::new(ObservingPrf(inner.prf_provider)));
            SupportedCipherSuite::Tls12(Box::leak(Box::new(rustls::Tls12CipherSuite {
                common: rustls::CipherSuiteCommon {
                    suite: inner.common.suite,
                    hash_provider: inner.common.hash_provider,
                    confidentiality_limit: inner.common.confidentiality_limit,
                },
                prf_provider: prf,
                kx: inner.kx,
                sign: inner.sign,
                aead_alg: inner.aead_alg,
            })))
        }
    }
}

struct ObservingHkdf(&'static dyn Hkdf);

impl Hkdf for ObservingHkdf {
    fn extract_from_zero_ikm(&self, salt: Option<&[u8]>) -> Box<dyn HkdfExpander> {
        self.0.extract_from_zero_ikm(salt)
    }

    fn extract_from_secret(&self, salt: Option<&[u8]>, secret: &[u8]) -> Box<dyn HkdfExpander> {
        self.0.extract_from_secret(salt, secret)
    }

    fn extract_from_kx_shared_secret(
        &self,
        salt: Option<&[u8]>,
        kx: Box<dyn ActiveKeyExchange>,
        peer_pub_key: &[u8],
    ) -> Result<Box<dyn HkdfExpander>, rustls::Error> {
        self.0.extract_from_kx_shared_secret(salt, kx, peer_pub_key)
    }

    fn expander_for_okm(&self, okm: &OkmBlock) -> Box<dyn HkdfExpander> {
        self.0.expander_for_okm(okm)
    }

    fn hmac_sign(&self, key: &OkmBlock, message: &[u8]) -> Tag {
        let tag = self.0.hmac_sign(key, message);
        observe(tag.as_ref());
        tag
    }

    fn fips(&self) -> bool {
        self.0.fips()
    }
}

struct ObservingPrf(&'static dyn Prf);

impl Prf for ObservingPrf {
    fn for_key_exchange(
        &self,
        output: &mut [u8; 48],
        kx: Box<dyn ActiveKeyExchange>,
        peer_pub_key: &[u8],
        label: &[u8],
        seed: &[u8],
    ) -> Result<(), rustls::Error> {
        self.0
            .for_key_exchange(output, kx, peer_pub_key, label, seed)
    }

    fn for_secret(&self, output: &mut [u8], secret: &[u8], label: &[u8], seed: &[u8]) {
        self.0.for_secret(output, secret, label, seed);
        if label == b"client finished" {
            observe(output);
        }
    }

    fn fips(&self) -> bool {
        self.0.fips()
    }
}
