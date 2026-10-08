import { LIMITS, PROTOCOL_VERSION } from "../../shared/constants";
import {
  GiphyShareRequestSchema,
  ServerMessageSchema,
  type ClientCommand,
  type GiphyMedia,
  type ServerMessage
} from "../../shared/protocol";
import { api, ApiRequestError } from "../api";
import type { Retro } from "../../shared/domain";

export type SocketStatus = "connecting" | "connected" | "offline" | "auth-required";

export type RetroSocketCallbacks = {
  onStatus: (status: SocketStatus) => void;
  onMessage: (message: ServerMessage) => void;
  onReady: () => void;
  onClosed: (retro: Retro) => void;
};

/** One board socket with bounded jittered reconnects and a fresh-snapshot readiness gate. */
export class RetroSocket {
  private readonly retroId: string;
  private readonly callbacks: RetroSocketCallbacks;
  private socket?: WebSocket;
  private stopped = false;
  private authRequired = false;
  private ready = false;
  private retryAttempt = 0;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private flushQueued = false;
  private readonly pending = new Map<string, ClientCommand>();
  private readonly onOnline = () => this.reconnectNow();
  private readonly onOffline = () => {
    if (!this.stopped && !this.authRequired) this.callbacks.onStatus("offline");
  };

  constructor(retroId: string, callbacks: RetroSocketCallbacks) {
    this.retroId = retroId;
    this.callbacks = callbacks;
  }

  start(): void {
    this.stopped = false;
    this.authRequired = false;
    window.addEventListener("online", this.onOnline);
    window.addEventListener("offline", this.onOffline);
    this.connect();
  }

  send(command: ClientCommand): boolean {
    this.pending.set(command.commandId, command);
    this.queueFlush();
    return this.ready;
  }

  sendGiphyShare(media: GiphyMedia): boolean {
    const socket = this.socket;
    if (!this.ready || socket?.readyState !== WebSocket.OPEN) return false;
    const frame = JSON.stringify(GiphyShareRequestSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      type: "giphy.share",
      media
    }));
    if (new TextEncoder().encode(frame).byteLength > LIMITS.incomingWebSocketFrameBytes) return false;
    try {
      socket.send(frame);
      return true;
    } catch {
      return false;
    }
  }

  private queueFlush(): void {
    if (!this.flushQueued) {
      this.flushQueued = true;
      queueMicrotask(() => {
        this.flushQueued = false;
        this.flush();
      });
    }
  }

  acknowledge(commandId: string): void {
    this.pending.delete(commandId);
  }

  requestFreshSnapshot(): void {
    if (this.stopped) return;
    this.reconnectNow();
  }

  close(): void {
    this.stopped = true;
    this.ready = false;
    window.removeEventListener("online", this.onOnline);
    window.removeEventListener("offline", this.onOffline);
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    const socket = this.socket;
    this.socket = undefined;
    socket?.close(1000, "Leaving board");
  }

  private connect(): void {
    if (this.stopped) return;
    this.ready = false;
    this.callbacks.onStatus("connecting");
    const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${scheme}//${window.location.host}/api/retros/${encodeURIComponent(this.retroId)}/ws?protocolVersion=${PROTOCOL_VERSION}`;
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.addEventListener("message", (event) => this.handleMessage(socket, event.data));
    socket.addEventListener("close", (event) => {
      if (this.socket !== socket || this.stopped) return;
      this.socket = undefined;
      this.ready = false;
      if (event.code === 4001 || event.code === 4401 || event.code === 4403) {
        this.authRequired = true;
        this.callbacks.onStatus("auth-required");
        return;
      }
      this.callbacks.onStatus("offline");
      void this.classifyDisconnect();
    });
    socket.addEventListener("error", () => {
      if (!this.stopped) this.callbacks.onStatus("offline");
    });
  }

  private handleMessage(socket: WebSocket, raw: unknown): void {
    if (this.socket !== socket || typeof raw !== "string") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      socket.close(1002, "Invalid server message");
      return;
    }
    const message = ServerMessageSchema.safeParse(parsed);
    if (!message.success) {
      socket.close(1002, "Invalid server message");
      return;
    }
    if (message.data.type === "auth.required") {
      this.ready = false;
      this.authRequired = true;
      this.callbacks.onStatus("auth-required");
      this.callbacks.onMessage(message.data);
      this.close();
      return;
    }
    if (message.data.type === "resync.required") {
      this.callbacks.onMessage(message.data);
      this.ready = false;
      socket.close(1012, "Fresh snapshot required");
      return;
    }
    this.callbacks.onMessage(message.data);
    if (message.data.type === "snapshot") {
      this.retryAttempt = 0;
      this.ready = true;
      this.callbacks.onStatus("connected");
      this.callbacks.onReady();
      this.flush();
    }
  }

  private flush(): void {
    if (!this.ready || this.socket?.readyState !== WebSocket.OPEN || this.pending.size === 0) return;
    const pending = [...this.pending.values()];
    const batch: ClientCommand[] = [];
    for (const command of pending) {
      if (batch.length >= 10) break;
      const candidate = [...batch, command];
      const encoded = JSON.stringify({ protocolVersion: PROTOCOL_VERSION, commands: candidate });
      if (new TextEncoder().encode(encoded).byteLength > 32 * 1024) {
        if (batch.length === 0) {
          this.pending.delete(command.commandId);
          this.callbacks.onStatus("offline");
        }
        break;
      }
      batch.push(command);
    }
    if (batch.length === 0) return;
    const frame = JSON.stringify({ protocolVersion: PROTOCOL_VERSION, commands: batch });
    this.socket.send(frame);
    for (const command of batch) this.pending.delete(command.commandId);
    if (this.pending.size > 0) this.queueFlush();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.authRequired || this.retryTimer !== undefined) return;
    const ceiling = Math.min(15_000, 500 * 2 ** this.retryAttempt);
    this.retryAttempt += 1;
    const delay = Math.min(15_000, Math.round(ceiling * (0.7 + Math.random() * 0.6)));
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.connect();
    }, delay);
  }

  private reconnectNow(): void {
    if (this.stopped || this.authRequired) return;
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    const current = this.socket;
    this.socket = undefined;
    this.ready = false;
    current?.close(1000, "Network restored");
    this.connect();
  }

  private async classifyDisconnect(): Promise<void> {
    try {
      await api.me();
      const retro = await api.retro(this.retroId);
      if (retro.status === "closed") {
        this.stopped = true;
        window.removeEventListener("online", this.onOnline);
        this.callbacks.onClosed(retro);
        return;
      }
      this.scheduleReconnect();
    } catch (error) {
      if (error instanceof ApiRequestError && ["AUTH_REQUIRED", "AUTH_EXPIRED", "FORBIDDEN"].includes(error.code)) {
        this.authRequired = true;
        this.callbacks.onStatus("auth-required");
        return;
      }
      this.scheduleReconnect();
    }
  }
}

export function isBoardEventMessage(message: ServerMessage): message is Extract<ServerMessage, { type: "events" }> {
  return message.type === "events";
}
