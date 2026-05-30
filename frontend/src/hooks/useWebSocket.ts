/**
 * Thin wrapper over the global WebSocket store. Keeps the existing API
 * (`subscribe` / `unsubscribe`) so call sites don't need changes.
 *
 * Components that pass an `onMessage` handler get their listener registered
 * on the singleton — the single connection fans out events to everyone.
 */
import { useEffect, useRef } from "react";
import { useAuthStore } from "../store/auth";
import { useWsStore } from "../store/ws";

// Smart default: match the page's protocol. https://… → wss://…/ws,
// http://… → ws://…/ws. Avoids the "wss to localhost without TLS" trap when
// VITE_WS_URL is unset or stale in a rebuilt bundle.
const DEFAULT_WS = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
const WS_URL = import.meta.env.VITE_WS_URL || DEFAULT_WS;

export interface WsEvent {
  type: string;
  data?: any;
}

export function useWebSocket(onMessage?: (e: WsEvent) => void) {
  const accessToken = useAuthStore((s) => s.accessToken);
  const connect = useWsStore((s) => s.connect);
  const disconnect = useWsStore((s) => s.disconnect);
  const addListener = useWsStore((s) => s.addListener);
  const subscribe = useWsStore((s) => s.subscribe);
  const unsubscribe = useWsStore((s) => s.unsubscribe);
  const connected = useWsStore((s) => s.connected);

  // Keep the LATEST handler in a ref so we can register the listener exactly
  // once (otherwise every render would churn the subscription).
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  // Ensure the single connection is opened/closed with auth state.
  useEffect(() => {
    if (accessToken) {
      connect(accessToken, WS_URL);
    } else {
      disconnect();
    }
  }, [accessToken, connect, disconnect]);

  // Register exactly once for the component's lifetime.
  useEffect(() => {
    if (!onMessageRef.current) return;
    return addListener((ev) => onMessageRef.current?.(ev));
  }, [addListener]);

  return { connected, subscribe, unsubscribe };
}
