import { WebSocketServer, WebSocket } from "ws";
import { EventEmitter } from "node:events";

export const BRIDGE_PORT = 47800;

export type ScreenSize = { width: number; height: number };

// Talks to the Electron overlay over a local WebSocket.
export class Bridge extends EventEmitter {
  private wss?: WebSocketServer;
  private overlay?: WebSocket;
  private pending = new Map<string, (v: any) => void>();
  screen?: ScreenSize;

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({ host: "127.0.0.1", port: BRIDGE_PORT });
      this.wss.on("listening", () => resolve());
      this.wss.on("error", reject);
      this.wss.on("connection", (ws) => {
        this.overlay = ws;
        ws.on("message", (raw) => this.onMessage(JSON.parse(raw.toString())));
        ws.on("close", () => {
          if (this.overlay === ws) this.overlay = undefined;
        });
      });
    });
  }

  private onMessage(msg: any) {
    if (msg.type === "hello") this.screen = { width: msg.width, height: msg.height };
    else if (msg.type === "user_message") this.emit("user_message", msg.text as string);
    else if (msg.id && this.pending.has(msg.id)) {
      this.pending.get(msg.id)!(msg);
      this.pending.delete(msg.id);
    }
  }

  get connected() {
    return this.overlay?.readyState === WebSocket.OPEN;
  }

  async waitForOverlay(timeoutMs = 8000) {
    const start = Date.now();
    while ((!this.connected || !this.screen) && Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!this.connected || !this.screen) throw new Error("Overlay is not connected");
    return this.screen;
  }

  send(msg: object) {
    if (!this.connected) throw new Error("Overlay is not connected");
    this.overlay!.send(JSON.stringify(msg));
  }

  request<T = any>(msg: object): Promise<T> {
    const id = Math.random().toString(36).slice(2);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("Overlay request timed out")), 3000);
      this.pending.set(id, (v) => {
        clearTimeout(t);
        resolve(v);
      });
      this.send({ ...msg, id });
    });
  }
}
