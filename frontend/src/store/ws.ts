/**
 * A single global WebSocket connection shared by the whole app.
 *
 * Previously each component using `useWebSocket` opened its OWN socket, so
 * unmounting/remounting a chat room (typical route change) would close the
 * connection and drop pending subscriptions — that's why new messages only
 * appeared after a full page reload.
 *
 * Now: one `WebSocket` lives in this module, every component registers a
 * listener and a set of channels it cares about. The socket is opened on
 * `connect(token)` and reconnected automatically.
 */
import { create } from "zustand";

type Listener = (event: { type: string; data?: any }) => void;

interface WsState {
  ws: WebSocket | null;
  connected: boolean;
  /** Channels we want to be subscribed to. */
  desired: Set<string>;
  /** Channels the server has confirmed for us. */
  active: Set<string>;
  listeners: Set<Listener>;
  reconnectTimer: any;
  /** Exponential-backoff delay in ms for the next reconnect attempt. */
  retryDelayMs: number;

  connect: (token: string, wsUrl: string) => void;
  disconnect: () => void;
  subscribe: (channel: string) => void;
  unsubscribe: (channel: string) => void;
  addListener: (l: Listener) => () => void;
}

export const useWsStore = create<WsState>((set, get) => ({
  ws: null,
  connected: false,
  desired: new Set(),
  active: new Set(),
  listeners: new Set(),
  reconnectTimer: null,
  retryDelayMs: 3000,

  connect(token, wsUrl) {
    const s = get();
    if (s.ws && (s.ws.readyState === WebSocket.OPEN || s.ws.readyState === WebSocket.CONNECTING)) {
      return; // already connecting/open
    }
    if (s.reconnectTimer) {
      clearTimeout(s.reconnectTimer);
    }

    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      // Gateway expects an explicit auth frame, then we re-subscribe.
      ws.send(JSON.stringify({ op: "auth", token }));
      for (const ch of get().desired) {
        ws.send(JSON.stringify({ op: "subscribe", channel: ch }));
      }
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "auth.ok") {
          // Successful handshake — reset the backoff so the next failure
          // starts from 3s, not whatever we'd grown to.
          set({ connected: true, retryDelayMs: 3000 });
        } else if (msg.type === "subscribed") {
          set((st) => ({ active: new Set(st.active).add(msg.data.channel) }));
        }
        for (const l of get().listeners) l(msg);
      } catch {}
    };

    ws.onclose = () => {
      const delay = get().retryDelayMs;
      set({ connected: false, active: new Set() });
      // Double the delay for the next attempt, capped at 30s. This stops the
      // 3-second hammering when the WS endpoint is misconfigured (e.g. wss
      // pointed at a host without TLS).
      const t = setTimeout(() => get().connect(token, wsUrl), delay);
      set({ reconnectTimer: t, retryDelayMs: Math.min(delay * 2, 30000) });
    };

    ws.onerror = () => ws.close();

    set({ ws });
  },

  disconnect() {
    const s = get();
    if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
    s.ws?.close();
    set({
      ws: null,
      connected: false,
      desired: new Set(),
      active: new Set(),
      reconnectTimer: null,
    });
  },

  subscribe(channel) {
    set((st) => ({ desired: new Set(st.desired).add(channel) }));
    const s = get();
    if (s.ws?.readyState === WebSocket.OPEN) {
      s.ws.send(JSON.stringify({ op: "subscribe", channel }));
    }
  },

  unsubscribe(channel) {
    set((st) => {
      const d = new Set(st.desired);
      d.delete(channel);
      return { desired: d };
    });
    const s = get();
    if (s.ws?.readyState === WebSocket.OPEN) {
      s.ws.send(JSON.stringify({ op: "unsubscribe", channel }));
    }
  },

  addListener(l) {
    set((st) => ({ listeners: new Set(st.listeners).add(l) }));
    return () => {
      set((st) => {
        const ls = new Set(st.listeners);
        ls.delete(l);
        return { listeners: ls };
      });
    };
  },
}));
