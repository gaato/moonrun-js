//! A minimal DER reader for the few certificate fields OpenSSL looks at and
//! webpki does not expose: the signature algorithm (RFC 5929
//! tls-server-endpoint), the validity period, the subject common names and
//! whether a subjectAltName carries DNS names (OpenSSL's CN fallback).

pub struct Der<'a> {
    data: &'a [u8],
}

pub struct Tlv<'a> {
    pub tag: u8,
    pub value: &'a [u8],
}

impl<'a> Der<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Self { data }
    }

    pub fn next(&mut self) -> Option<Tlv<'a>> {
        let (&tag, rest) = self.data.split_first()?;
        let (&first, mut rest) = rest.split_first()?;
        let len = if first < 0x80 {
            usize::from(first)
        } else {
            let count = usize::from(first & 0x7f);
            if count == 0 || count > 4 || rest.len() < count {
                return None;
            }
            let mut len = 0usize;
            for &byte in &rest[..count] {
                len = (len << 8) | usize::from(byte);
            }
            rest = &rest[count..];
            len
        };
        if rest.len() < len {
            return None;
        }
        let (value, rest) = rest.split_at(len);
        self.data = rest;
        Some(Tlv { tag, value })
    }

    fn expect(&mut self, tag: u8) -> Option<&'a [u8]> {
        let tlv = self.next()?;
        (tlv.tag == tag).then_some(tlv.value)
    }
}

const SEQUENCE: u8 = 0x30;
const SET: u8 = 0x31;
const OID: u8 = 0x06;
const UTC_TIME: u8 = 0x17;
const GENERALIZED_TIME: u8 = 0x18;

/// The parts of a certificate this crate needs.
pub struct CertInfo<'a> {
    pub signature_algorithm: &'a [u8],
    pub not_before: u64,
    pub not_after: u64,
    subject: &'a [u8],
    extensions: Option<&'a [u8]>,
}

pub fn parse_certificate(cert: &[u8]) -> Option<CertInfo<'_>> {
    let mut outer = Der::new(Der::new(cert).expect(SEQUENCE)?);
    let mut tbs = Der::new(outer.expect(SEQUENCE)?);
    let signature_algorithm = Der::new(outer.expect(SEQUENCE)?).expect(OID)?;

    let mut field = tbs.next()?;
    if field.tag == 0xa0 {
        field = tbs.next()?; // version
    }
    let _serial = field;
    tbs.expect(SEQUENCE)?; // signature
    tbs.expect(SEQUENCE)?; // issuer
    let mut validity = Der::new(tbs.expect(SEQUENCE)?);
    let not_before = parse_time(validity.next()?)?;
    let not_after = parse_time(validity.next()?)?;
    let subject = tbs.expect(SEQUENCE)?;
    tbs.expect(SEQUENCE)?; // subjectPublicKeyInfo
    let mut extensions = None;
    while let Some(tlv) = tbs.next() {
        if tlv.tag == 0xa3 {
            extensions = Some(Der::new(tlv.value).expect(SEQUENCE)?);
        }
    }
    Some(CertInfo {
        signature_algorithm,
        not_before,
        not_after,
        subject,
        extensions,
    })
}

impl<'a> CertInfo<'a> {
    /// Values of every commonName attribute in the subject, in order.
    pub fn subject_common_names(&self) -> Vec<&'a [u8]> {
        const CN: &[u8] = &[0x55, 0x04, 0x03];
        let mut names = Vec::new();
        let mut rdns = Der::new(self.subject);
        while let Some(rdn) = rdns.next() {
            if rdn.tag != SET {
                continue;
            }
            let mut attributes = Der::new(rdn.value);
            while let Some(attribute) = attributes.next() {
                let mut attribute = Der::new(attribute.value);
                if attribute.expect(OID) == Some(CN)
                    && let Some(value) = attribute.next()
                {
                    names.push(value.value);
                }
            }
        }
        names
    }

    /// Whether a subjectAltName extension carries at least one dNSName.
    pub fn has_dns_subject_alt_name(&self) -> bool {
        const SAN: &[u8] = &[0x55, 0x1d, 0x11];
        let Some(extensions) = self.extensions else {
            return false;
        };
        let mut extensions = Der::new(extensions);
        while let Some(extension) = extensions.next() {
            let mut extension = Der::new(extension.value);
            if extension.expect(OID) != Some(SAN) {
                continue;
            }
            let mut value = extension.next();
            if value.as_ref().is_some_and(|v| v.tag == 0x01) {
                value = extension.next(); // critical
            }
            let Some(octets) = value.filter(|v| v.tag == 0x04) else {
                return false;
            };
            let Some(names) = Der::new(octets.value).expect(SEQUENCE) else {
                return false;
            };
            let mut names = Der::new(names);
            while let Some(name) = names.next() {
                if name.tag == 0x82 {
                    return true;
                }
            }
        }
        false
    }
}

fn parse_time(tlv: Tlv<'_>) -> Option<u64> {
    let text = core::str::from_utf8(tlv.value).ok()?;
    let text = text.strip_suffix('Z')?;
    let (year, rest) = match tlv.tag {
        UTC_TIME => {
            let yy: u64 = text.get(0..2)?.parse().ok()?;
            (if yy < 50 { 2000 + yy } else { 1900 + yy }, text.get(2..)?)
        }
        GENERALIZED_TIME => (text.get(0..4)?.parse().ok()?, text.get(4..)?),
        _ => return None,
    };
    let number = |range: core::ops::Range<usize>| -> Option<u64> { rest.get(range)?.parse().ok() };
    let month = number(0..2)?;
    let day = number(2..4)?;
    let hour = number(4..6)?;
    let minute = number(6..8)?;
    let second = if rest.len() >= 10 { number(8..10)? } else { 0 };
    if !(1..=12).contains(&month) || day == 0 || day > 31 || hour > 23 || minute > 59 || second > 60
    {
        return None;
    }
    Some(days_from_civil(year, month, day) * 86_400 + hour * 3600 + minute * 60 + second)
}

/// Days since 1970-01-01 (proleptic Gregorian), for years >= 1970.
fn days_from_civil(year: u64, month: u64, day: u64) -> u64 {
    let (y, m) = if month <= 2 {
        (year - 1, month + 9)
    } else {
        (year, month - 3)
    };
    let era = y / 400;
    let yoe = y - era * 400;
    let doy = (153 * m + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    (era * 146_097 + doe).saturating_sub(719_468)
}

/// The digest RFC 5929 prescribes for tls-server-endpoint, following OpenSSL's
/// `OBJ_find_sigid_algs`: the signature's own hash, with MD5 and SHA-1
/// upgraded to SHA-256. `None` when OpenSSL has no digest for the algorithm
/// (RSASSA-PSS, Ed25519, Ed448) or ring cannot compute it (SHA-224).
pub fn server_endpoint_digest(
    signature_algorithm: &[u8],
) -> Option<&'static ring::digest::Algorithm> {
    use ring::digest::{SHA256, SHA384, SHA512};
    const RSA: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01];
    const ECDSA_SHA1: &[u8] = &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x01];
    const ECDSA_SHA2: &[u8] = &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03];
    const DSA_SHA1: &[u8] = &[0x2a, 0x86, 0x48, 0xce, 0x38, 0x04, 0x03];
    const DSA_SHA2: &[u8] = &[0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x03];
    if let Some(last) = signature_algorithm.strip_prefix(RSA) {
        return match last {
            [0x04] | [0x05] | [0x0b] => Some(&SHA256), // md5, sha1, sha256 WithRSAEncryption
            [0x0c] => Some(&SHA384),
            [0x0d] => Some(&SHA512),
            _ => None,
        };
    }
    if signature_algorithm == ECDSA_SHA1 || signature_algorithm == DSA_SHA1 {
        return Some(&SHA256);
    }
    if let Some(last) = signature_algorithm.strip_prefix(ECDSA_SHA2) {
        return match last {
            [0x02] => Some(&SHA256),
            [0x03] => Some(&SHA384),
            [0x04] => Some(&SHA512),
            _ => None,
        };
    }
    if let Some(last) = signature_algorithm.strip_prefix(DSA_SHA2) {
        return match last {
            [0x02] => Some(&SHA256),
            _ => None,
        };
    }
    None
}
