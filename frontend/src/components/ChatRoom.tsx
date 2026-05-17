import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import {
  decryptForRoom,
  encryptForRoom,
  generateSenderKey,
  loadSenderKey,
  saveSenderKey,
} from "../crypto";
import { useWebSocket } from "../hooks/useWebSocket";
import { useAuthStore } from "../store/auth";

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
}

export default function ChatRoom({ roomId }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const userId = useAuthStore((s) => s.userId);

  // Ensure local sender key exists.
  useEffect(() => {
    (async () => {
      let key = await loadSenderKey(roomId);
      if (!key) {
        key = await generateSenderKey();
        await saveSenderKey(roomId, key);
      }
    })();
  }, [roomId]);

  // Load history when switching rooms
  useEffect(() => {
    setMessages([]);
    (async () => {
      try {
        const { data } = await api.get<Message[]>(`/messages/room/${roomId}`);
        const decoded = await Promise.all(
          data.map(async (m) => {
            try {
              const pt = await decryptForRoom(roomId, m.ciphertext);
              return { ...m, plaintext: pt };
            } catch {
              return { ...m, plaintext: "🔒 [encrypted — no key]" };
            }
          })
        );
        setMessages(decoded);
      } catch (e: any) {
        setError(e?.response?.data?.detail || "Failed to load");
      }
    })();
  }, [roomId]);

  // Helper: insert message if not yet present (dedupe by id)
  function upsertMessage(m: Message) {
    setMessages((prev) => {
      if (prev.some((x) => x.id === m.id)) return prev;
      return [...prev, m];
    });
  }

  const { subscribe, unsubscribe } = useWebSocket(async (ev) => {
    if (ev.type === "message.new" && ev.data?.room_id === roomId) {
      let pt: string;
      try {
        pt = await decryptForRoom(roomId, ev.data.ciphertext);
      } catch {
        pt = "🔒 [encrypted — no key]";
      }
      upsertMessage({ ...ev.data, plaintext: pt });
    } else if (ev.type === "message.deleted") {
      setMessages((prev) => prev.filter((m) => m.id !== ev.data?.id));
    }
  });

  useEffect(() => {
    subscribe(`room:${roomId}`);
    return () => unsubscribe(`room:${roomId}`);
  }, [roomId, subscribe, unsubscribe]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages]);

  async function send() {
    if (!input.trim()) return;
    const text = input;
    setInput("");
    try {
      const ct = await encryptForRoom(roomId, text);
      // POST returns the saved message; insert it immediately for the sender.
      // WS event will arrive too but will be deduped by id.
      const { data } = await api.post<Message>("/messages", {
        room_id: roomId,
        ciphertext: ct,
      });
      upsertMessage({ ...data, plaintext: text });
    } catch (e: any) {
      setError(e?.message || "Send failed");
      setInput(text); // restore input on failure
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div ref={listRef} className="flex-1 overflow-y-auto p-4 space-y-2">
        {error && <div className="text-red-400 text-sm">{error}</div>}
        {messages.map((m) => (
          <div key={m.id} className="bg-panel rounded p-2">
            <div className="text-xs text-muted">
              {m.sender_id === userId ? "you" : m.sender_id.slice(0, 8)} ·{" "}
              {new Date(m.created_at).toLocaleTimeString()}
            </div>
            <div className="text-sm whitespace-pre-wrap break-words">{m.plaintext}</div>
          </div>
        ))}
      </div>
      <div className="p-4 bg-panel flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder="Message..."
          className="flex-1 bg-bg p-2 rounded border border-panel2"
        />
        <button onClick={send} className="bg-accent px-4 rounded">
          Send
        </button>
      </div>
    </div>
  );
}
