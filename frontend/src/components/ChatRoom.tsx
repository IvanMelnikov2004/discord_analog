import { useEffect, useState } from "react";
import { api } from "../api";
import { decryptFromSender, encryptWithMyKey } from "../crypto";
import { fetchAndStoreSenderKeys, setupRoomKeys } from "../senderKeys";
import { useWebSocket } from "../hooks/useWebSocket";
import { useMemberRoles } from "../hooks/useMemberRoles";
import { useMyPermissions } from "../hooks/useMyPermissions";
import { useMessagePagination } from "../hooks/useMessagePagination";
import { useAuthStore } from "../store/auth";
import { parseRateLimit } from "../rateLimit";

interface Message {
  id: string;
  sender_id: string;
  room_id: string | null;
  ciphertext: string;
  created_at: string;
  plaintext?: string;
}

interface Props {
  roomId: string;
  channelId: string;
}

export default function ChatRoom({ roomId, channelId }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [rateLimitMsg, setRateLimitMsg] = useState("");
  const [sendDisabledUntil, setSendDisabledUntil] = useState(0);
  const userId = useAuthStore((s) => s.userId)!;
  const { data: roleInfo = {} } = useMemberRoles(channelId);
  const { can, perms } = useMyPermissions(channelId);

  // Pagination: container ref + onScroll handler that calls fetchOlder when
  // the user nears the top. decryptBatch runs on each fetched page so old
  // messages decrypt the same way new ones do.
  const decryptBatch = async (batch: Message[]) =>
    Promise.all(batch.map((m) => decryptMsg(m)));
  const { containerRef, onScroll, loading: loadingOlder, hasMore } =
    useMessagePagination<Message>({
      messages,
      setMessages,
      fetchOlder: async (before) => {
        const { data } = await api.get<Message[]>(`/messages/room/${roomId}`, {
          params: { before, limit: 50 },
        });
        return data;
      },
      decryptBatch,
    });

  async function deleteMessage(id: string, isOwn: boolean) {
    try {
      // For own messages no channel_id needed; for others the server checks
      // MANAGE_MESSAGES via channel-service using the channel_id query param.
      const url = isOwn
        ? `/messages/${id}`
        : `/messages/${id}?channel_id=${channelId}`;
      await api.delete(url);
      setMessages((prev) => prev.filter((m) => m.id !== id));
    } catch (e: any) {
      setError(e?.response?.data?.detail || "Не удалось удалить");
    }
  }

  // Try to decrypt a single message using its sender's key. If we don't have
  // that sender's key yet, return a placeholder so the user sees something
  // sensible until the key arrives (then retryLockedMessages will refresh it).
  async function decryptMsg(m: Message): Promise<Message> {
    try {
      const pt = await decryptFromSender(roomId, m.sender_id, m.ciphertext);
      return { ...m, plaintext: pt };
    } catch {
      return { ...m, plaintext: "🔒 [зашифровано — ключ ещё не получен]" };
    }
  }

  // After receiving new sender keys, try to re-decrypt any locked messages.
  async function retryLockedMessages() {
    const current = await new Promise<Message[]>((resolve) => {
      setMessages((prev) => {
        resolve(prev);
        return prev;
      });
    });
    const updated = await Promise.all(
      current.map((m) =>
        m.plaintext && !m.plaintext.startsWith("🔒") ? m : decryptMsg(m)
      )
    );
    setMessages(updated);
  }

  // Set up sender keys when entering the room: ensure mine, distribute to
  // other members, fetch envelopes addressed to me. Then load history.
  const [keysReady, setKeysReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setKeysReady(false);
    (async () => {
      try {
        await setupRoomKeys(roomId, channelId, userId);
      } catch (e) {
        console.warn("setupRoomKeys failed:", e);
      }
      if (!cancelled) setKeysReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [roomId, channelId, userId]);

  // Load history once keys are ready (so old messages can be decrypted on the
  // first pass when possible).
  useEffect(() => {
    if (!keysReady) return;
    setMessages([]);
    (async () => {
      try {
        const { data } = await api.get<Message[]>(`/messages/room/${roomId}`);
        const decoded = await Promise.all(data.map((m) => decryptMsg(m)));
        setMessages(decoded);
      } catch (e: any) {
        setError(e?.response?.data?.detail || "Не удалось загрузить историю");
      }
    })();
  }, [roomId, keysReady]);

  function upsertMessage(m: Message) {
    setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
  }

  const { subscribe, unsubscribe } = useWebSocket(async (ev) => {
    if (ev.type === "message.new" && ev.data?.room_id === roomId) {
      const decoded = await decryptMsg(ev.data);
      upsertMessage(decoded);
    } else if (ev.type === "message.deleted") {
      setMessages((prev) => prev.filter((m) => m.id !== ev.data?.id));
    } else if (ev.type === "senderkey.new" && ev.data?.room_id === roomId) {
      // A new sender's envelope is now available for me — fetch + retry
      // any locked messages that referenced this sender.
      await fetchAndStoreSenderKeys(roomId);
      await retryLockedMessages();
    } else if (ev.type === "member.joined" && ev.data?.channel_id === channelId) {
      // A new member joined the channel I'm in. Re-share my sender key so
      // they can decrypt my future messages without needing to wait for me
      // to remount the room.
      try {
        await setupRoomKeys(roomId, channelId, userId);
      } catch (e) {
        console.warn("re-distribute after member.joined failed:", e);
      }
    }
  });

  useEffect(() => {
    subscribe(`room:${roomId}`);
    return () => unsubscribe(`room:${roomId}`);
  }, [roomId, subscribe, unsubscribe]);

  // Auto-scroll to bottom on new messages, but ONLY if the user was already
  // near the bottom. Otherwise we'd yank them away from history they're
  // reading — same UX rule Slack/Discord use.
  useEffect(() => {
    const c = containerRef.current;
    if (!c) return;
    const nearBottom =
      c.scrollHeight - c.scrollTop - c.clientHeight < 150;
    if (nearBottom) {
      c.scrollTo({ top: c.scrollHeight });
    }
  }, [messages, containerRef]);

  async function send() {
    if (!input.trim()) return;
    if (perms?.muted) {
      setError("Вы замьючены в этом канале");
      return;
    }
    // Client-side guard against double-clicking before the server window
    // resets. The authoritative limit still comes from the server.
    if (Date.now() < sendDisabledUntil) return;
    const text = input;
    setInput("");
    try {
      const ct = await encryptWithMyKey(roomId, userId, text);
      // channel_id is required server-side to verify mute / SEND_MESSAGES.
      const { data } = await api.post<Message>("/messages", {
        room_id: roomId,
        channel_id: channelId,
        ciphertext: ct,
      });
      upsertMessage({ ...data, plaintext: text });
      setRateLimitMsg("");
    } catch (e: any) {
      const rl = parseRateLimit(e);
      if (rl) {
        setRateLimitMsg(rl.message);
        setSendDisabledUntil(Date.now() + rl.retryAfterSeconds * 1000);
        // Auto-clear the notice once the window expires.
        setTimeout(() => setRateLimitMsg(""), rl.retryAfterSeconds * 1000);
      } else {
        setError(e?.response?.data?.detail || e?.message || "Не удалось отправить");
      }
      setInput(text);
    }
  }

  // Format the mute-until time for the disabled-input label.
  const mutedLabel = (() => {
    if (!perms?.muted) return null;
    if (!perms.muted_until) return "Вы замьючены в этом канале (навсегда)";
    const until = new Date(perms.muted_until);
    return `Вы замьючены до ${until.toLocaleString()}`;
  })();

  return (
    <div className="flex flex-col h-full">
      <div
        ref={containerRef}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto p-4 space-y-2"
      >
        {loadingOlder && (
          <div className="text-center text-xs text-muted py-2">
            Загрузка предыдущих сообщений…
          </div>
        )}
        {!hasMore && messages.length > 0 && (
          <div className="text-center text-xs text-muted py-2">
            — начало переписки —
          </div>
        )}
        {error && <div className="text-red-400 text-sm">{error}</div>}
        {!keysReady && (
          <div className="text-muted text-sm">Установка ключей шифрования…</div>
        )}
        {messages.map((m) => {
          const info = roleInfo[m.sender_id];
          const role = info?.topRole;
          const displayName =
            m.sender_id === userId ? "вы" : info?.nickname || m.sender_id.slice(0, 8);
          const nameStyle = role?.color ? { color: role.color } : undefined;
          const isOwn = m.sender_id === userId;
          const canDelete = isOwn || can("MANAGE_MESSAGES");
          return (
            <div key={m.id} className="bg-panel rounded p-2 group">
              <div className="text-xs text-muted flex items-center gap-2">
                <span className="font-medium" style={nameStyle}>
                  {displayName}
                </span>
                {role && (
                  <span
                    className="px-1.5 py-0.5 rounded text-[10px] font-medium"
                    style={{
                      backgroundColor: (role.color || "#979c9f") + "33",
                      color: role.color || "#979c9f",
                    }}
                  >
                    {role.name}
                  </span>
                )}
                <span>· {new Date(m.created_at).toLocaleTimeString()}</span>
                {canDelete && (
                  <button
                    onClick={() => deleteMessage(m.id, isOwn)}
                    className="ml-auto opacity-0 group-hover:opacity-100 text-muted hover:text-red-400"
                    title="Удалить сообщение"
                  >
                    ✕
                  </button>
                )}
              </div>
              <div className="text-sm whitespace-pre-wrap break-words">{m.plaintext}</div>
            </div>
          );
        })}
      </div>
      <div className="p-4 bg-panel">
        {mutedLabel && (
          <div className="text-xs text-amber-400 mb-2">🔇 {mutedLabel}</div>
        )}
        {rateLimitMsg && (
          <div className="text-xs text-amber-400 mb-2">⏳ {rateLimitMsg}</div>
        )}
        <div className="flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()}
            placeholder={perms?.muted ? "Отправка запрещена" : "Сообщение…"}
            disabled={!!perms?.muted}
            className="flex-1 bg-bg p-2 rounded border border-panel2 disabled:opacity-50 disabled:cursor-not-allowed"
          />
          <button
            onClick={send}
            disabled={!!perms?.muted || Date.now() < sendDisabledUntil}
            className="bg-accent px-4 rounded disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Отправить
          </button>
        </div>
      </div>
    </div>
  );
}
