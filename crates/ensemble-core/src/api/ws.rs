use crate::api::router::AppState;
use crate::interaction::store::InteractionStore;
use crate::observability::events::PipelineEvent;
use crate::observability::snapshot::build_issue_snapshot;
use axum::extract::ws::{Message, WebSocket};
use axum::extract::{Path, State, WebSocketUpgrade};
use axum::response::IntoResponse;
use futures_util::stream::StreamExt;
use futures_util::SinkExt;
use tracing::{debug, warn};

/// GET /ws/events/{identifier}
///
/// WebSocket upgrade handler for streaming live events for a specific issue.
/// On connect: sends the current issue detail snapshot.
/// Then streams matching PipelineEvents from the event bus.
/// Closes on PipelineEvent::Complete or client disconnect.
pub async fn ws_events(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Path(identifier): Path<String>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_ws(socket, state, identifier))
}

async fn handle_ws(socket: WebSocket, state: AppState, identifier: String) {
    let (mut sender, mut receiver) = socket.split();

    let config_dir = state
        .config_runtime
        .config_path
        .parent()
        .map(std::path::Path::to_path_buf)
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    let interaction_store = InteractionStore::new(config_dir);

    // 1. Send initial snapshot on connect
    {
        let lock = state.orchestrator_state.read().await;
        let snapshot = build_issue_snapshot(
            &lock,
            &identifier,
            &state.workspace_root,
            Some(&interaction_store),
        )
        .await;
        drop(lock);

        let initial_msg = serde_json::json!({
            "type": "snapshot",
            "data": snapshot,
        });

        if sender
            .send(Message::Text(
                serde_json::to_string(&initial_msg).unwrap().into(),
            ))
            .await
            .is_err()
        {
            return; // Client disconnected
        }
    }

    // 2. Subscribe to event bus
    let mut rx = state.event_bus.subscribe();

    // 3. Stream events, filtering by identifier
    loop {
        tokio::select! {
            // Event from bus
            event = rx.recv() => {
                match event {
                    Ok(event) if event.issue_identifier() == identifier => {
                        let is_complete = matches!(event, PipelineEvent::Complete { .. });

                        let msg = serde_json::json!({
                            "type": "event",
                            "data": event,
                        });

                        if sender
                            .send(Message::Text(serde_json::to_string(&msg).unwrap().into()))
                            .await
                            .is_err()
                        {
                            debug!(identifier = %identifier, "WebSocket client disconnected");
                            break;
                        }

                        if is_complete {
                            debug!(identifier = %identifier, "pipeline complete, closing WebSocket");
                            let _ = sender.send(Message::Close(None)).await;
                            break;
                        }
                    }
                    Ok(_) => {
                        // Event for a different issue, skip
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                        warn!(identifier = %identifier, lagged = n, "WebSocket subscriber lagged");
                        // Continue receiving — some events were lost but that's acceptable
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        debug!(identifier = %identifier, "event bus closed, closing WebSocket");
                        break;
                    }
                }
            }
            // Client message (ping/pong handled by axum, but we watch for close)
            msg = receiver.next() => {
                match msg {
                    Some(Ok(Message::Close(_))) | None => {
                        debug!(identifier = %identifier, "WebSocket client closed connection");
                        break;
                    }
                    Some(Err(_)) => {
                        debug!(identifier = %identifier, "WebSocket error, closing");
                        break;
                    }
                    _ => {
                        // Ignore other client messages (text, binary)
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    // WebSocket integration tests require a full server setup.
    // Core logic is covered by the event bus tests and snapshot tests.
    // Full WS integration testing is deferred to Plan 5's integration test suite.

    #[test]
    fn ws_handler_module_compiles() {
        // This test exists to verify the ws module compiles correctly
        // with all its dependencies.
    }
}
