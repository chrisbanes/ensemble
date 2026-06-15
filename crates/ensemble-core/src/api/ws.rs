use crate::api::router::AppState;
use crate::interaction::store::InteractionStore;
use crate::observability::events::PipelineEvent;
use crate::observability::snapshot::{
    build_issue_snapshot, enrich_issue_snapshot_pending_input, IssueDetailSnapshot,
};
use crate::transcript::model::TranscriptRecord;
use axum::extract::ws::{Message, WebSocket};
use axum::extract::{Path, State, WebSocketUpgrade};
use axum::response::IntoResponse;
use futures_util::stream::StreamExt;
use futures_util::SinkExt;
use serde::Serialize;
use tracing::{debug, warn};

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum WsServerMessage<'a> {
    Snapshot {
        data: &'a Option<IssueDetailSnapshot>,
    },
    Event {
        data: &'a PipelineEvent,
    },
    TranscriptRecord {
        data: &'a TranscriptRecord,
    },
}

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
        let mut snapshot = {
            let lock = state.orchestrator_state.read().await;
            build_issue_snapshot(&lock, &identifier, &state.workspace_root, None).await
        };
        if let Some(detail) = snapshot.as_mut() {
            enrich_issue_snapshot_pending_input(detail, &interaction_store).await;
        }

        let initial_msg = WsServerMessage::Snapshot { data: &snapshot };

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
    let mut transcript_rx = state.transcript_event_bus.subscribe();

    // 3. Stream events, filtering by identifier
    loop {
        tokio::select! {
            // Event from bus
            event = rx.recv() => {
                match event {
                    Ok(event) if event.issue_identifier() == identifier => {
                        let is_complete = matches!(event, PipelineEvent::Complete { .. });

                        let msg = WsServerMessage::Event { data: &event };

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
            record = transcript_rx.recv() => {
                match record {
                    Ok(record) if record.issue_identifier == identifier => {
                        let msg = WsServerMessage::TranscriptRecord { data: &record };
                        if sender
                            .send(Message::Text(serde_json::to_string(&msg).unwrap().into()))
                            .await
                            .is_err()
                        {
                            debug!(identifier = %identifier, "WebSocket client disconnected");
                            break;
                        }
                    }
                    Ok(_) => {
                        // Transcript record for a different issue, skip
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                        warn!(identifier = %identifier, lagged = n, "WebSocket transcript subscriber lagged");
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        debug!(identifier = %identifier, "transcript event bus closed, closing WebSocket");
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
    use super::*;

    // WebSocket integration tests require a full server setup.
    // Core logic is covered by the event bus tests and snapshot tests.
    // Full WS integration testing is deferred to Plan 5's integration test suite.

    #[test]
    fn ws_handler_module_compiles() {
        // This test exists to verify the ws module compiles correctly
        // with all its dependencies.
    }

    #[test]
    fn transcript_record_message_serializes_with_stable_type() {
        let record = crate::transcript::model::TranscriptRecord {
            schema_version: crate::transcript::model::TRANSCRIPT_SCHEMA_VERSION,
            run_id: "run-1".to_string(),
            issue_identifier: "repo#1".to_string(),
            step_name: "build".to_string(),
            attempt: 1,
            sequence: 3,
            timestamp: chrono::Utc::now(),
            kind: crate::transcript::model::TranscriptRecordKind::AssistantMessage,
            payload: serde_json::json!({"text": "hello"}),
            truncated: None,
        };

        let value =
            serde_json::to_value(WsServerMessage::TranscriptRecord { data: &record }).unwrap();

        assert_eq!(value["type"], "transcript_record");
        assert_eq!(value["data"]["issue_identifier"], "repo#1");
        assert_eq!(value["data"]["sequence"], 3);
        assert_eq!(value["data"]["payload"]["text"], "hello");
    }
}
