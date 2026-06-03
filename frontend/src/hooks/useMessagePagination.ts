/**
 * Backwards-pagination helper for chat history.
 *
 * The chat list is ordered oldest→newest at the bottom. To load older
 * messages we pass `before=<oldest visible message's timestamp>` to the
 * server, prepend the returned batch, and restore the scroll position so
 * the screen doesn't jump.
 *
 * Usage:
 *   const { containerRef, onScroll, prependBatch } = useMessagePagination<Msg>({
 *     messages, setMessages,
 *     fetchOlder: async (before) => {
 *       const { data } = await api.get<Msg[]>(`/messages/room/${roomId}`, {
 *         params: { before, limit: 50 },
 *       });
 *       return data; // server returns ascending; we'll prepend as-is
 *     },
 *     decryptBatch,   // optional; called on each batch before prepending
 *   });
 *
 *   <div ref={containerRef} onScroll={onScroll}>...</div>
 */
import { useCallback, useEffect, useRef, useState } from "react";

interface PaginatedMessage {
  id: string;
  created_at: string;
}

interface Options<M extends PaginatedMessage> {
  messages: M[];
  setMessages: (updater: (prev: M[]) => M[]) => void;
  /** Fetch the page strictly older than the given ISO timestamp. */
  fetchOlder: (before: string) => Promise<M[]>;
  /** Optional post-processing (e.g. decryption) before prepending. */
  decryptBatch?: (batch: M[]) => Promise<M[]>;
  /** Page size hint — when fewer items return we mark "no more". */
  pageSize?: number;
}

export function useMessagePagination<M extends PaginatedMessage>({
  messages,
  setMessages,
  fetchOlder,
  decryptBatch,
  pageSize = 50,
}: Options<M>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);

  // Reset state when the entire message list is cleared (e.g. switching room).
  // We detect this via length === 0 with hasMore=false in the same tick — but
  // simpler: expose a `reset` action.
  const reset = useCallback(() => {
    setHasMore(true);
    setLoading(false);
  }, []);

  const loadOlder = useCallback(async () => {
    if (loading || !hasMore) return;
    if (messages.length === 0) return; // nothing to anchor `before` to
    const oldest = messages[0];
    setLoading(true);

    const container = containerRef.current;
    // Capture pre-prepend scroll metrics so we can restore the user's view.
    const prevScrollHeight = container?.scrollHeight ?? 0;
    const prevScrollTop = container?.scrollTop ?? 0;

    try {
      let batch = await fetchOlder(oldest.created_at);
      if (decryptBatch) batch = await decryptBatch(batch);

      // Filter out anything we already have (defensive: server might overlap).
      const existing = new Set(messages.map((m) => m.id));
      const deduped = batch.filter((m) => !existing.has(m.id));

      if (deduped.length === 0) {
        // Server returned only duplicates or nothing → no more history.
        setHasMore(false);
      } else {
        // The server returns ascending; prepend so order stays right.
        setMessages((prev) => [...deduped, ...prev]);
        // Less than a full page means we've reached the start.
        if (batch.length < pageSize) setHasMore(false);
      }

      // Restore scroll: new content was prepended, so to keep what the user
      // was looking at on-screen we shift scrollTop by the delta in height.
      requestAnimationFrame(() => {
        const c = containerRef.current;
        if (!c) return;
        const newHeight = c.scrollHeight;
        c.scrollTop = prevScrollTop + (newHeight - prevScrollHeight);
      });
    } catch (e) {
      // Soft-fail: stop trying for this scroll, user can scroll again later.
      console.warn("loadOlder failed:", e);
    } finally {
      setLoading(false);
    }
  }, [loading, hasMore, messages, fetchOlder, decryptBatch, setMessages, pageSize]);

  // Trigger when the user scrolls near the top (within 100px).
  const onScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      if (e.currentTarget.scrollTop < 100) {
        void loadOlder();
      }
    },
    [loadOlder]
  );

  // Also reset when messages array becomes empty (e.g. room change).
  useEffect(() => {
    if (messages.length === 0) reset();
  }, [messages.length, reset]);

  return { containerRef, onScroll, loading, hasMore, reset };
}
