//! Server certificate verification with OpenSSL's observable behaviour where
//! it differs from webpki in ways moonbitlang/async's own tests depend on:
//! - a self-signed certificate that is itself a trusted root is accepted as
//!   the server certificate (OpenSSL finds the leaf in the store), even with
//!   `CA:TRUE`;
//! - when the certificate has no DNS subjectAltName, the host is matched
//!   against the subject commonName (`X509_check_host` without
//!   `X509_CHECK_FLAG_NEVER_CHECK_SUBJECT`), with
//!   `X509_CHECK_FLAG_NO_PARTIAL_WILDCARDS`.

use std::sync::Arc;

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::client::{verify_server_cert_signed_by_trust_anchor, verify_server_name};
use rustls::crypto::{WebPkiSupportedAlgorithms, verify_tls12_signature, verify_tls13_signature};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::server::ParsedCertificate;
use rustls::{CertificateError, DigitallySignedStruct, Error, RootCertStore, SignatureScheme};

use crate::der;

/// A parsed root store plus the DER of each root (for the leaf-is-root rule).
pub struct Roots {
    pub store: RootCertStore,
    pub ders: Vec<Vec<u8>>,
}

impl Roots {
    /// `strict`: every entry must parse (custom roots, like `X509::from_der`);
    /// otherwise unparsable entries are skipped (system bundles).
    pub fn new(ders: Vec<Vec<u8>>, strict: bool) -> Result<Self, String> {
        let mut store = RootCertStore::empty();
        let mut kept = Vec::with_capacity(ders.len());
        for der in ders {
            match store.add(CertificateDer::from(der.as_slice())) {
                Ok(()) => kept.push(der),
                Err(error) if strict => {
                    return Err(format!("failed to parse TLS root certificate: {error}"));
                }
                Err(_) => {}
            }
        }
        #[cfg(feature = "webpki-roots")]
        if !strict && kept.is_empty() {
            store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        }
        Ok(Self { store, ders: kept })
    }
}

#[derive(Debug, Clone)]
pub enum NameCheck {
    /// Empty host: no hostname verification.
    Skip,
    Dns(String),
    Ip(ServerName<'static>),
}

pub struct Verifier {
    /// `None` = trust mode 0 (no chain or name verification).
    roots: Option<Arc<Roots>>,
    name: NameCheck,
    algorithms: WebPkiSupportedAlgorithms,
}

impl core::fmt::Debug for Verifier {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("Verifier")
            .field("verify", &self.roots.is_some())
            .finish()
    }
}

impl Verifier {
    pub fn new(
        roots: Option<Arc<Roots>>,
        name: NameCheck,
        algorithms: WebPkiSupportedAlgorithms,
    ) -> Self {
        Self {
            roots,
            name,
            algorithms,
        }
    }
}

impl ServerCertVerifier for Verifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, Error> {
        let Some(roots) = &self.roots else {
            return Ok(ServerCertVerified::assertion());
        };
        verify_chain(roots, end_entity, intermediates, now, &self.algorithms)?;
        verify_name(end_entity, &self.name)?;
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        verify_tls12_signature(message, cert, dss, &self.algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        verify_tls13_signature(message, cert, dss, &self.algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.algorithms.supported_schemes()
    }
}

fn verify_chain(
    roots: &Roots,
    end_entity: &CertificateDer<'_>,
    intermediates: &[CertificateDer<'_>],
    now: UnixTime,
    algorithms: &WebPkiSupportedAlgorithms,
) -> Result<(), Error> {
    if roots
        .ders
        .iter()
        .any(|root| root.as_slice() == end_entity.as_ref())
    {
        // The leaf is itself trusted: OpenSSL only checks its validity period.
        let info = der::parse_certificate(end_entity)
            .ok_or(Error::InvalidCertificate(CertificateError::BadEncoding))?;
        let now = now.as_secs();
        if now < info.not_before {
            return Err(Error::InvalidCertificate(CertificateError::NotValidYet));
        }
        if now > info.not_after {
            return Err(Error::InvalidCertificate(CertificateError::Expired));
        }
        return Ok(());
    }
    if roots.store.is_empty() {
        return Err(Error::InvalidCertificate(CertificateError::UnknownIssuer));
    }
    let cert = ParsedCertificate::try_from(end_entity)?;
    verify_server_cert_signed_by_trust_anchor(
        &cert,
        &roots.store,
        intermediates,
        now,
        algorithms.all,
    )
}

fn verify_name(end_entity: &CertificateDer<'_>, name: &NameCheck) -> Result<(), Error> {
    match name {
        NameCheck::Skip => Ok(()),
        NameCheck::Ip(ip) => {
            let cert = ParsedCertificate::try_from(end_entity)?;
            verify_server_name(&cert, ip)
        }
        NameCheck::Dns(host) => {
            let mismatch = Error::InvalidCertificate(CertificateError::NotValidForName);
            let info = der::parse_certificate(end_entity);
            if info
                .as_ref()
                .is_some_and(|info| !info.has_dns_subject_alt_name())
            {
                let info = info.as_ref().ok_or(mismatch.clone())?;
                // `do_x509_check` accepts any matching commonName attribute.
                let names = info.subject_common_names();
                return if names.iter().any(|cn| host_matches(cn, host)) {
                    Ok(())
                } else {
                    Err(mismatch)
                };
            }
            let server_name = ServerName::try_from(host.as_str()).map_err(|_| mismatch.clone())?;
            let cert = ParsedCertificate::try_from(end_entity)?;
            verify_server_name(&cert, &server_name)
        }
    }
}

/// `X509_check_host` matching of one presented name with
/// `X509_CHECK_FLAG_NO_PARTIAL_WILDCARDS`: case-insensitive, a wildcard only
/// as the whole leftmost label, at least two labels after it.
fn host_matches(pattern: &[u8], host: &str) -> bool {
    let host = host.strip_suffix('.').unwrap_or(host).as_bytes();
    if pattern.eq_ignore_ascii_case(host) {
        return true;
    }
    let Some(suffix) = pattern.strip_prefix(b"*.") else {
        return false;
    };
    if suffix.iter().filter(|&&b| b == b'.').count() < 1 || suffix.contains(&b'*') {
        return false;
    }
    let Some(dot) = host.iter().position(|&b| b == b'.') else {
        return false;
    };
    dot > 0 && host[dot + 1..].eq_ignore_ascii_case(suffix)
}
