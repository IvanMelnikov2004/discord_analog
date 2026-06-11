/**
 * Live tracking of voice-room participants in a channel.
 *
 * Maintains a `Record<roomId, string[]>` of user identities currently in
 * each voice room. Initial snapshot comes from
 * `GET /api/media/channels/{id}/voice-participants`, then LiveKit webhooks
 * (via media-service → Redis → gateway) keep it in sync over WebSocket on
 * topic `channel:<channelId>:voice`.
 *
 * Used by:
 *   - ChannelPage sidebar to show "(N)" counts next to voice room names
 *   - VoiceRoom to render a preview of who's already inside before joining
 */
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useWebSocket } from "./useWebSocket";

interface VoiceEvent {
  type: string;
  data?: {
    channel_id?: string;
    room_id?: string;
    user_id?: string;
  };
}

export function useVoicePresence(channelId: string | undefined) {
  // Map roomId → identities currently in that voice room.
  const [presence, setPresence] = useState<Record<string, string[]>>({});

  // Keep the latest channelId in a ref so the WS handler can compare
  // without re-registering every render.
  const channelIdRef = useRef(channelId);
  channelIdRef.current = channelId;

  // Initial snapshot — runs whenever channelId changes (entering a new
  // channel). Until this resolves the lists are empty; that's fine, just
  // counts read 0 briefly.
  useEffect(() => {
    if (!channelId) return;
    let cancelled = false;
    (async () => {
      try {
        const { data } = await api.get<Record<string, string[]>>(
          `/media/channels/${channelId}/voice-participants`
        );
        if (!cancelled) setPresence(data || {});
      } catch {
        // Soft fail — webhooks will fill it in as people come/go.
        if (!cancelled) setPresence({});
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [channelId]);

  // Subscribe to the channel-wide voice topic for live updates.
  const { subscribe, unsubscribe } = useWebSocket((ev: VoiceEvent) => {
    const cur = channelIdRef.current;
    if (!cur || !ev?.data || ev.data.channel_id !== cur) return;
    const roomId = ev.data.room_id;
    const userId = ev.data.user_id;
    if (!roomId || !userId) return;

    if (ev.type === "voice.participant_joined") {
      setPresence((prev) => {
        const list = prev[roomId] || [];
        // Defensive: webhook can occasionally fire twice during reconnects.
        if (list.includes(userId)) return prev;
        return { ...prev, [roomId]: [...list, userId] };
      });
    } else if (ev.type === "voice.participant_left") {
      setPresence((prev) => {
        const list = prev[roomId];
        if (!list) return prev;
        const next = list.filter((u) => u !== userId);
        if (next.length === list.length) return prev;
        return { ...prev, [roomId]: next };
      });
    }
  });

  useEffect(() => {
    if (!channelId) return;
    const topic = `channel:${channelId}:voice`;
    subscribe(topic);
    return () => unsubscribe(topic);
  }, [channelId, subscribe, unsubscribe]);

  return presence;
}
