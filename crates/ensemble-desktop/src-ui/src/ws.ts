import type { WsMessage } from "./types";

export type WsStatus = "connecting" | "connected" | "disconnected";

export interface UseWsOptions {
  identifier: string;
  onMessage: (msg: WsMessage) => void;
  onStatusChange?: (status: WsStatus) => void;
  enabled?: boolean;
}

/**
 * Creates and manages a WebSocket connection for live event streaming.
 * Automatically reconnects with exponential backoff on disconnect.
 * Returns a cleanup function.
 */
export function connectWs(options: UseWsOptions): () => void {
  const { identifier, onMessage, onStatusChange, enabled = true } = options;

  if (!enabled || !identifier) {
    return () => {};
  }

  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectDelay = 1000;
  let intentionallyClosed = false;

  function connect() {
    onStatusChange?.("connecting");
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${window.location.host}/ws/events/${encodeURIComponent(identifier)}`;
    ws = new WebSocket(url);

    ws.onopen = () => {
      reconnectDelay = 1000;
      onStatusChange?.("connected");
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as WsMessage;
        onMessage(msg);
      } catch {
        // Ignore malformed messages.
      }
    };

    ws.onclose = () => {
      onStatusChange?.("disconnected");
      if (!intentionallyClosed) {
        reconnectTimer = setTimeout(() => {
          reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
          connect();
        }, reconnectDelay);
      }
    };

    ws.onerror = () => {
      ws?.close();
    };
  }

  connect();

  return () => {
    intentionallyClosed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    ws?.close();
  };
}
