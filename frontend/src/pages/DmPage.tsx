import { useEffect, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { useAuthStore } from "../store/auth";
import { useWebSocket } from "../hooks/useWebSocket";
import { useMessagePagination } from "../hooks/useMessagePagination";
import { decryptDmFromSender, encryptDmWithMyKey } from "../crypto";
import { fetchAndStorePeerDmKey, setupDmKeys } from "../dmKeys";
import { parseRateLimit } from "../rateLimit";
import Avatar from "../components/Avatar";

interface Message {
  id: string;
  sender_id: string;
  recipient_id: string | null;
  ciphertext: string;
  created_at: string;
  plaintext?: string;
}

interface Profile {
  user_id: string;
  username: string;
  display_name: string | null;
}

// dm_pair on the server is `${min(a,b)}:${max(a,b)}` — replicate on the client
// so we can build the WebSocket channel string the server publishes on.
function dmPair(a: string, b: string): string {
  return [a, b].sort().join(":");
}

export default function DmPage() {
  const { peerId } = useParams<{ peerId: string }>();
  const navigate = useNavigate();
  const myId = useAuthStore((s) => s.userId)!;

  // Self-DM is meaningless: redirect home.
  useEffect(() => {
    if (peerId === myId) navigate("/");
  }, [peerId, myId, navigate]);

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [keysReady, setKeysReady] = useState(false);
  const [rateLimitMsg, setRateLimitMsg] = useState("");
  const [sendDisabledUntil, setSendDisabledUntil] = useState(0);

  // Decrypt a single DM. peerId is the conversation key; senderId picks
  // whose key to use (mine for outgoing, peer's for incoming).
  async function decryptMsg(m: Message): Promise<Message> {
    try {
      const pt = await decryptDmFromSender(peerId!, m.sender_id, m.ciphertext);
      return { ...m, plaintext: pt };
    } catch {
      return { ...m, plaintext: "🔒 [зашифровано — ключ ещё не получен]" };
    }
  }

  // Backwards pagination on scroll-up.
  const { containerRef, onScroll, loading: loadingOlder, hasMore } =
    useMessagePagination<Message>({
      messages,
      setMessages,
      fetchOlder: async (before) => {
        const { data } = await api.get<Message[]>(`/messages/dm/${peerId}`, {
          params: { before, limit: 50 },
        });
        return data;
      },
      decryptBatch: (batch) => Promise.all(batch.map((m) => decryptMsg(m))),
    });

  const { data: peer } = useQuery<Profile>({
    queryKey: ["profile", peerId],
    queryFn: async () => (await api.get<Profile>(`/users/${peerId}`)).data,
    enabled: !!peerId,
  });

  // Set up the pairwise DM keys when entering a conversation.
  useEffect(() => {
    if (!peerId) return;
    let cancelled = false;
    setKeysReady(false);
    (async () => {
      try {
        await setupDmKeys(peerId, myId);
      } catch (e) {
        console.warn("setupDmKeys failed:", e);
      }
      if (!cancelled) setKeysReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [peerId, myId]);

  // Load history after keys are ready.
  useEffect(() => {
    if (!keysReady || !peerId) return;
    setMessages([]);
    (async () => {
      try {
        const { data } = await api.get<Message[]>(`/messages/dm/${peerId}`);
        const decoded = await Promise.all(data.map((m) => decryptMsg(m)));
        setMessages(decoded);
      } catch (e: any) {
        setError(e?.response?.data?.detail || "Не удалось загрузить переписку");
      }
    })();
  }, [peerId, keysReady]);

  function upsertMessage(m: Message) {
    setMessages((prev) =>
      prev.some((x) => x.id === m.id) ? prev : [...prev, m]
    );
  }

  // Subscribe to the server-side dm pub/sub channel for realtime delivery.
  const { subscribe, unsubscribe } = useWebSocket(async (ev) => {
    if (!peerId) return;
    const pair = dmPair(myId, peerId);
    if (ev.type === "message.new" && ev.data?.dm_pair === pair) {
      const decoded = await decryptMsg(ev.data);
      upsertMessage(decoded);
    } else if (ev.type === "message.deleted") {
      setMessages((prev) => prev.filter((m) => m.id !== ev.data?.id));
    } else if (
      ev.type === "senderkey.new" &&
      ev.data?.sender_id === peerId
    ) {
      // Peer just (re-)distributed their DM key — fetch and retry locked.
      await fetchAndStorePeerDmKey(peerId, myId);
      setMessages((cur) => {
        void (async () => {
          const updated = await Promise.all(
            cur.map((m) =>
              m.plaintext && !m.plaintext.startsWith("🔒") ? m : decryptMsg(m)
            )
          );
          setMessages(updated);
        })();
        return cur;
      });
    }
  });

  useEffect(() => {
    if (!peerId) return;
    const channel = `dm:${dmPair(myId, peerId)}`;
    subscribe(channel);
    return () => unsubscribe(channel);
  }, [peerId, myId, subscribe, unsubscribe]);

  // On the first load of a conversation, jump to the latest message. Track
  // per `peerId` so switching DMs triggers a fresh initial jump.
  const [initialScrollDone, setInitialScrollDone] = useState(false);
  useEffect(() => {
    setInitialScrollDone(false);
  }, [peerId]);
  useEffect(() => {
    if (initialScrollDone) return;
    if (messages.length === 0) return;
    const c = containerRef.current;
    if (!c) return;
    requestAnimationFrame(() => {
      c.scrollTop = c.scrollHeight;
      setInitialScrollDone(true);
    });
  }, [messages, initialScrollDone, containerRef]);

  // Auto-scroll on new messages only when the user is already near the
  // bottom — otherwise we'd yank them out of older history they're reading.
  useEffect(() => {
    if (!initialScrollDone) return;
    const c = containerRef.current;
    if (!c) return;
    const nearBottom = c.scrollHeight - c.scrollTop - c.clientHeight < 150;
    if (nearBottom) c.scrollTo({ top: c.scrollHeight });
  }, [messages, initialScrollDone, containerRef]);

  async function send() {
    if (!input.trim() || !peerId) return;
    if (Date.now() < sendDisabledUntil) return;
    const text = input;
    setInput("");
    try {
      const ct = await encryptDmWithMyKey(peerId, myId, text);
      const { data } = await api.post<Message>("/messages", {
        recipient_id: peerId,
        ciphertext: ct,
      });
      upsertMessage({ ...data, plaintext: text });
      setRateLimitMsg("");
    } catch (e: any) {
      const rl = parseRateLimit(e);
      if (rl) {
        setRateLimitMsg(rl.message);
        setSendDisabledUntil(Date.now() + rl.retryAfterSeconds * 1000);
        setTimeout(() => setRateLimitMsg(""), rl.retryAfterSeconds * 1000);
      } else {
        setError(e?.response?.data?.detail || e?.message || "Не удалось отправить");
      }
      setInput(text);
    }
  }

  if (!peerId) return null;
  const peerName = peer?.display_name || peer?.username || peerId.slice(0, 8);

  return (
    <div className="h-full flex flex-col">
      <header className="bg-panel border-b border-panel2 p-3 flex items-center gap-3">
        <Link to="/" className="text-muted text-sm">←</Link>
        <Avatar seed={peerId} name={peerName} size={36} />
        <div className="flex-1">
          <div className="font-medium">
            <Link to={`/profile/${peerId}`} className="hover:underline">
              {peerName}
            </Link>
          </div>
          {peer?.username && (
            <div className="text-xs text-muted">@{peer.username}</div>
          )}
        </div>
      </header>

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
          const mine = m.sender_id === myId;
          return (
            <div
              key={m.id}
              className={`bg-panel rounded p-2 max-w-[80%] ${mine ? "ml-auto" : ""}`}
            >
              <div className="text-xs text-muted">
                {mine ? "вы" : peerName} ·{" "}
                {new Date(m.created_at).toLocaleTimeString()}
              </div>
              <div className="text-sm whitespace-pre-wrap break-words">
                {m.plaintext}
              </div>
            </div>
          );
        })}
      </div>

      <div className="p-4 bg-panel">
        {rateLimitMsg && (
          <div className="text-xs text-amber-400 mb-2">⏳ {rateLimitMsg}</div>
        )}
        <div className="flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()}
            placeholder="Сообщение…"
            className="flex-1 bg-bg p-2 rounded border border-panel2"
          />
          <button
            onClick={send}
            disabled={Date.now() < sendDisabledUntil}
            className="bg-accent px-4 rounded disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Отправить
          </button>
        </div>
      </div>
    </div>
  );
}
