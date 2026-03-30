export type {
  WsEventData,
  WsEventMessage,
  WsPipelineEvent,
  WsSnapshotMessage,
} from "./ws-events";

import type { WsEventMessage, WsSnapshotMessage } from "./ws-events";

export type WsMessage = WsSnapshotMessage | WsEventMessage;
