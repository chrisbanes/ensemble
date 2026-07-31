use axum::http::uri::Authority;
use axum::http::{header, HeaderMap, Uri};
use std::net::{IpAddr, SocketAddr};
use std::str::FromStr;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ApiExposure {
    TrustedLocal,
    UnsafeRemote,
}

#[derive(Debug, Eq, PartialEq, thiserror::Error)]
#[error("refusing non-loopback API bind address {addr}")]
pub struct RemoteBindRejected {
    pub addr: SocketAddr,
}

pub fn classify_bind_addr(
    addr: SocketAddr,
    unsafe_allow_remote: bool,
) -> Result<ApiExposure, RemoteBindRejected> {
    if addr.ip().is_loopback() {
        Ok(ApiExposure::TrustedLocal)
    } else if unsafe_allow_remote {
        Ok(ApiExposure::UnsafeRemote)
    } else {
        Err(RemoteBindRejected { addr })
    }
}

#[derive(Debug, Eq, PartialEq, thiserror::Error)]
pub enum WebSocketSecurityError {
    #[error("missing Host header")]
    MissingHost,
    #[error("missing Origin header")]
    MissingOrigin,
    #[error("malformed Host header")]
    MalformedHost,
    #[error("malformed Origin header")]
    MalformedOrigin,
    #[error("WebSocket Origin does not match Host")]
    OriginMismatch,
    #[error("WebSocket Host is not loopback")]
    NonLoopbackHost,
}

pub fn validate_websocket_origin(
    exposure: ApiExposure,
    host: Option<&str>,
    origin: Option<&str>,
) -> Result<(), WebSocketSecurityError> {
    let host = host.ok_or(WebSocketSecurityError::MissingHost)?;
    let host = Authority::from_str(host).map_err(|_| WebSocketSecurityError::MalformedHost)?;
    if host.as_str().contains('@') {
        return Err(WebSocketSecurityError::MalformedHost);
    }
    let origin = origin.ok_or(WebSocketSecurityError::MissingOrigin)?;
    let origin = Uri::from_str(origin).map_err(|_| WebSocketSecurityError::MalformedOrigin)?;
    let valid_scheme = origin
        .scheme_str()
        .is_some_and(|scheme| matches!(scheme, "http" | "https"));
    if !valid_scheme || origin.path() != "/" || origin.query().is_some() {
        return Err(WebSocketSecurityError::MalformedOrigin);
    }
    let origin = origin
        .authority()
        .ok_or(WebSocketSecurityError::MalformedOrigin)?;
    if origin.as_str().contains('@') {
        return Err(WebSocketSecurityError::MalformedOrigin);
    }

    if !host.host().eq_ignore_ascii_case(origin.host()) || host.port_u16() != origin.port_u16() {
        return Err(WebSocketSecurityError::OriginMismatch);
    }

    if matches!(exposure, ApiExposure::TrustedLocal) && !is_loopback_host(host.host()) {
        Err(WebSocketSecurityError::NonLoopbackHost)
    } else {
        Ok(())
    }
}

pub fn validate_websocket_headers(
    exposure: ApiExposure,
    headers: &HeaderMap,
) -> Result<(), WebSocketSecurityError> {
    let host = match headers
        .get_all(header::HOST)
        .iter()
        .collect::<Vec<_>>()
        .as_slice()
    {
        [] => return Err(WebSocketSecurityError::MissingHost),
        [host] => host
            .to_str()
            .map_err(|_| WebSocketSecurityError::MalformedHost)?,
        _ => return Err(WebSocketSecurityError::MalformedHost),
    };
    let origin = match headers
        .get_all(header::ORIGIN)
        .iter()
        .collect::<Vec<_>>()
        .as_slice()
    {
        [] => return Err(WebSocketSecurityError::MissingOrigin),
        [origin] => origin
            .to_str()
            .map_err(|_| WebSocketSecurityError::MalformedOrigin)?,
        _ => return Err(WebSocketSecurityError::MalformedOrigin),
    };

    validate_websocket_origin(exposure, Some(host), Some(origin))
}

fn is_loopback_host(host: &str) -> bool {
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }

    host.trim_start_matches('[')
        .trim_end_matches(']')
        .parse::<IpAddr>()
        .is_ok_and(|address| address.is_loopback())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    #[test]
    fn trusted_local_bind_accepts_ipv4_loopback() {
        let addr: SocketAddr = "127.0.0.1:3000".parse().unwrap();

        assert_eq!(
            classify_bind_addr(addr, false).unwrap(),
            ApiExposure::TrustedLocal
        );
    }

    #[test]
    fn trusted_local_bind_accepts_ipv6_loopback() {
        let addr: SocketAddr = "[::1]:3000".parse().unwrap();

        assert_eq!(
            classify_bind_addr(addr, false).unwrap(),
            ApiExposure::TrustedLocal
        );
    }

    #[test]
    fn trusted_local_bind_rejects_non_loopback_addresses() {
        for addr in ["0.0.0.0:3000", "192.168.1.20:3000", "[::]:3000"] {
            let addr: SocketAddr = addr.parse().unwrap();
            assert_eq!(
                classify_bind_addr(addr, false),
                Err(RemoteBindRejected { addr })
            );
        }
    }

    #[test]
    fn unsafe_remote_bind_requires_explicit_opt_in() {
        let addr: SocketAddr = "192.168.1.20:3000".parse().unwrap();

        assert_eq!(
            classify_bind_addr(addr, true),
            Ok(ApiExposure::UnsafeRemote)
        );
    }

    #[test]
    fn websocket_security_accepts_same_origin_localhost() {
        assert!(validate_websocket_origin(
            ApiExposure::TrustedLocal,
            Some("localhost:3000"),
            Some("http://localhost:3000"),
        )
        .is_ok());
    }

    #[test]
    fn websocket_security_accepts_same_origin_loopback_authorities() {
        for (host, origin) in [
            ("localhost", "https://localhost"),
            ("LOCALHOST:3000", "http://localhost:3000"),
            ("127.0.0.1:8080", "http://127.0.0.1:8080"),
            ("[::1]:9090", "https://[::1]:9090"),
        ] {
            assert_eq!(
                validate_websocket_origin(ApiExposure::TrustedLocal, Some(host), Some(origin)),
                Ok(()),
                "expected {host} and {origin} to be accepted"
            );
        }
    }

    #[test]
    fn websocket_security_rejects_missing_or_malformed_headers() {
        for (host, origin, expected) in [
            (
                None,
                Some("http://localhost:3000"),
                WebSocketSecurityError::MissingHost,
            ),
            (
                Some("localhost:3000"),
                None,
                WebSocketSecurityError::MissingOrigin,
            ),
            (
                Some("http://localhost:3000"),
                Some("http://localhost:3000"),
                WebSocketSecurityError::MalformedHost,
            ),
            (
                Some("user@localhost:3000"),
                Some("http://localhost:3000"),
                WebSocketSecurityError::MalformedHost,
            ),
            (
                Some("localhost:3000"),
                Some("null"),
                WebSocketSecurityError::MalformedOrigin,
            ),
            (
                Some("localhost:3000"),
                Some("ftp://localhost:3000"),
                WebSocketSecurityError::MalformedOrigin,
            ),
            (
                Some("localhost:3000"),
                Some("http://localhost:3000/path"),
                WebSocketSecurityError::MalformedOrigin,
            ),
            (
                Some("localhost:3000"),
                Some("http://user@localhost:3000"),
                WebSocketSecurityError::MalformedOrigin,
            ),
        ] {
            assert_eq!(
                validate_websocket_origin(ApiExposure::TrustedLocal, host, origin),
                Err(expected)
            );
        }
    }

    #[test]
    fn websocket_security_rejects_cross_origin_and_non_loopback_authorities() {
        for (host, origin, expected) in [
            (
                "localhost:3000",
                "http://localhost:3001",
                WebSocketSecurityError::OriginMismatch,
            ),
            (
                "localhost:3000",
                "http://127.0.0.1:3000",
                WebSocketSecurityError::OriginMismatch,
            ),
            (
                "192.168.1.20:3000",
                "http://192.168.1.20:3000",
                WebSocketSecurityError::NonLoopbackHost,
            ),
            (
                "example.test:3000",
                "https://example.test:3000",
                WebSocketSecurityError::NonLoopbackHost,
            ),
        ] {
            assert_eq!(
                validate_websocket_origin(ApiExposure::TrustedLocal, Some(host), Some(origin)),
                Err(expected)
            );
        }
    }

    #[test]
    fn unsafe_remote_websocket_still_requires_same_origin() {
        assert_eq!(
            validate_websocket_origin(
                ApiExposure::UnsafeRemote,
                Some("192.168.1.20:3000"),
                Some("http://192.168.1.20:3000"),
            ),
            Ok(())
        );
        assert_eq!(
            validate_websocket_origin(
                ApiExposure::UnsafeRemote,
                Some("192.168.1.20:3000"),
                Some("http://attacker.example:3000"),
            ),
            Err(WebSocketSecurityError::OriginMismatch)
        );
    }

    #[test]
    fn websocket_security_rejects_duplicate_origin_headers() {
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, HeaderValue::from_static("localhost:3000"));
        headers.append(
            header::ORIGIN,
            HeaderValue::from_static("http://localhost:3000"),
        );
        headers.append(
            header::ORIGIN,
            HeaderValue::from_static("http://attacker.example"),
        );

        assert_eq!(
            validate_websocket_headers(ApiExposure::TrustedLocal, &headers),
            Err(WebSocketSecurityError::MalformedOrigin)
        );
    }
}
