use std::net::{SocketAddr, ToSocketAddrs};
use std::path::PathBuf;
use std::process::ExitCode;
use tracing::{error, info, warn};

use ensemble_core::api::bootstrap::{
    build_app_state, clear_registered_orchestrator, start_or_replace_registered_orchestrator,
    take_registered_orchestrator,
};
use ensemble_core::api::router::create_api_router;
use ensemble_core::config::draft::load_config_document_or_missing;
use ensemble_core::config::location::resolve_config_dir_for_cli;
use ensemble_core::observability::events::EventBus;

use crate::embedded_ui::spa_router;

#[derive(Debug, Clone)]
pub struct WebArgs {
    pub config_dir: Option<PathBuf>,
    pub host: String,
    pub port: Option<u16>,
}

fn resolve_bind_addr(host: &str, port: u16) -> std::io::Result<SocketAddr> {
    (host, port).to_socket_addrs()?.next().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::AddrNotAvailable,
            format!("no socket addresses resolved for {}:{}", host, port),
        )
    })
}

#[cfg(test)]
fn bind_addr_display(host: &str, port: u16) -> String {
    match resolve_bind_addr(host, port) {
        Ok(addr) => addr.to_string(),
        Err(_) => format!("{}:{}", host, port),
    }
}

/// Run the orchestrator with web UI (SPA + API server)
///
/// This now serves the UI and API regardless of config state.
/// If config is missing or invalid, the UI will show the setup wizard.
pub async fn execute(args: WebArgs) -> ExitCode {
    let cwd = match std::env::current_dir() {
        Ok(dir) => dir,
        Err(e) => {
            error!(error = %e, "failed to get current directory");
            eprintln!("error: failed to get current directory: {}", e);
            return ExitCode::FAILURE;
        }
    };

    let resolved = match resolve_config_dir_for_cli(
        args.config_dir.as_deref(),
        std::env::var_os("ENSEMBLE_CONFIG_DIR"),
        &cwd,
    ) {
        Ok(r) => r,
        Err(e) => {
            error!(error = %e, "failed to resolve config directory");
            eprintln!("error: failed to resolve config directory: {}", e);
            return ExitCode::FAILURE;
        }
    };

    info!(
        config_dir = %resolved.config_dir.display(),
        config_path = %resolved.config_path.display(),
        host = %args.host,
        port = ?args.port,
        "starting ensemble in web mode"
    );

    let document_state = load_config_document_or_missing(&resolved.config_path);
    let prepared = build_app_state(
        resolved.config_path.clone(),
        document_state,
        EventBus::new(),
    );

    if prepared.has_runnable_config {
        let document_state = prepared
            .app_state
            .config_runtime
            .document_state
            .read()
            .await;
        let config = document_state.active_config.as_ref().unwrap();
        info!(
            tracker_kind = %config.tracker.kind,
            poll_interval_ms = config.polling.interval_ms,
            max_concurrent = config.concurrency.max_concurrent_agents,
            "config loaded successfully - orchestrator can run"
        );
    } else {
        let config_kind = {
            prepared
                .app_state
                .config_runtime
                .document_state
                .read()
                .await
                .kind
                .clone()
        };
        warn!(
            config_state = ?config_kind,
            "no valid config found - serving UI in setup mode"
        );
        eprintln!(
            "warning: no valid config found at {}",
            resolved.config_path.display()
        );
        eprintln!(
            "  The UI will show the setup wizard. Configure ensemble to start the orchestrator."
        );
    }
    let has_runnable_config = prepared.has_runnable_config;
    let app_state = prepared.app_state;
    if has_runnable_config {
        match start_or_replace_registered_orchestrator(&app_state).await {
            Ok(true) => info!("orchestrator started"),
            Ok(false) => {
                error!("runnable config did not produce an orchestrator runtime");
                eprintln!("error: runnable config did not produce an orchestrator runtime");
                return ExitCode::FAILURE;
            }
            Err(e) => {
                error!(error = %e, "failed to start orchestrator");
                eprintln!("error: failed to start orchestrator: {}", e);
                return ExitCode::FAILURE;
            }
        }
    } else {
        clear_registered_orchestrator(&app_state).await;
    }

    // Create combined router: API routes + SPA fallback
    let api_router = create_api_router(app_state.clone());
    let spa_router = spa_router();

    let router = api_router.merge(spa_router);

    // Warn if binding to a non-loopback address (exposes unauthenticated API)
    let is_loopback = args.host == "127.0.0.1" || args.host == "::1" || args.host == "localhost";
    if !is_loopback {
        warn!(
            host = %args.host,
            "binding to a non-loopback address exposes the API without authentication"
        );
        eprintln!(
            "warning: binding to {} exposes the ensemble API to the network without authentication",
            args.host
        );
    }

    // Determine port
    let port = args.port.unwrap_or(0); // 0 = let OS assign available port
    let bind_addr = match resolve_bind_addr(&args.host, port) {
        Ok(addr) => addr,
        Err(e) => {
            error!(error = %e, host = %args.host, port, "failed to resolve HTTP bind address");
            eprintln!(
                "error: failed to resolve HTTP bind address for {}:{}: {}",
                args.host, port, e
            );
            return ExitCode::FAILURE;
        }
    };
    let bind_addr_display = bind_addr.to_string();

    info!(addr = %bind_addr_display, "starting HTTP server");

    let listener = match tokio::net::TcpListener::bind(bind_addr).await {
        Ok(l) => l,
        Err(e) => {
            error!(error = %e, addr = %bind_addr_display, "failed to bind HTTP server");
            eprintln!(
                "error: failed to bind HTTP server on {}: {}",
                bind_addr_display, e
            );
            return ExitCode::FAILURE;
        }
    };

    let actual_addr = match listener.local_addr() {
        Ok(addr) => addr,
        Err(e) => {
            error!(error = %e, "failed to get local address");
            eprintln!("error: failed to get local address: {}", e);
            return ExitCode::FAILURE;
        }
    };
    info!(
        addr = %actual_addr,
        "HTTP server listening. Open http://{} in your browser",
        actual_addr
    );

    // Start server in background
    let server_handle = tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, router).await {
            error!(error = %e, "HTTP server error");
        }
    });

    if !has_runnable_config {
        info!("orchestrator disabled - waiting for valid config via setup wizard");
    }

    info!("ensemble web mode is running (press Ctrl+C to stop)");

    // Wait for shutdown signal (ctrl-c)
    match tokio::signal::ctrl_c().await {
        Ok(()) => {
            info!("received shutdown signal");
        }
        Err(e) => {
            error!(error = %e, "failed to listen for shutdown signal");
        }
    }

    // Clean shutdown
    server_handle.abort();
    if let Some(runtime) = take_registered_orchestrator(&app_state) {
        runtime.shutdown().await;
    }
    info!("HTTP server stopped");

    info!("ensemble shut down cleanly");
    ExitCode::SUCCESS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_web_args() {
        let args = WebArgs {
            config_dir: Some(PathBuf::from("/tmp/test")),
            host: "0.0.0.0".to_string(),
            port: Some(8080),
        };
        assert_eq!(args.config_dir, Some(PathBuf::from("/tmp/test")));
        assert_eq!(args.host, "0.0.0.0");
        assert_eq!(args.port, Some(8080));
    }

    #[test]
    fn test_web_args_defaults() {
        let args = WebArgs {
            config_dir: None,
            host: "127.0.0.1".to_string(),
            port: None,
        };
        assert!(args.config_dir.is_none());
        assert_eq!(args.host, "127.0.0.1");
        assert_eq!(args.port, None);
    }

    #[test]
    fn bind_addr_display_wraps_ipv6_hosts() {
        assert_eq!(bind_addr_display("::1", 8080), "[::1]:8080");
    }
}
