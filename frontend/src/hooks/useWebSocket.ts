import { useEffect, useRef, useState } from "react";
import { useAuthStore } from "../store/auth";

const WS_URL = import.meta.env.VITE_WS_URL || `ws://${location.host}/ws`;

export interface WsEvent {
  type: string;
  data?: any;
}

export function useWebSocket(onMessage: (e: WsEvent) => void) {
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const accessToken = useAuthStore((s) => s.accessToken);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  useEffect(() => {
    if (!accessToken) return;

    let cancelled = false;

    const connect = () => {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify({ op: "auth", token: accessToken }));
      };

      ws.onmessage = (ev) => {
        try {
          const msg: WsEvent = JSON.parse(ev.data);
          if (msg.type === "auth.ok") {
            setConnected(true);
          } else {
            onMessageRef.current(msg);
          }
        } catch {}
      };

      ws.onclose = () => {
        setConnected(false);
        if (!cancelled) {
          setTimeout(connect, 3000);
        }
      };

      ws.onerror = () => ws.close();
    };

    connect();

    return () => {
      cancelled = true;
      wsRef.current?.close();
    };
  }, [accessToken]);

  const send = (payload: object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(payload));
    }
  };

  const subscribe = (channel: string) => send({ op: "subscribe", channel });
  const unsubscribe = (channel: string) => send({ op: "unsubscribe", channel });

  return { connected, send, subscribe, unsubscribe };
}
