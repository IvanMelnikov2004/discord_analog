import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";

interface Ban {
  id: string;
  channel_id: string;
  user_id: string;
  reason: string | null;
  banned_by: string;
  created_at: string;
}

interface Props {
  channelId: string;
  onClose: () => void;
}

export default function BanList({ channelId, onClose }: Props) {
  const qc = useQueryClient();

  const { data: bans = [], isLoading } = useQuery({
    queryKey: ["bans", channelId],
    queryFn: async () => (await api.get<Ban[]>(`/channels/${channelId}/bans`)).data,
  });

  const unban = useMutation({
    mutationFn: async (userId: string) =>
      api.delete(`/channels/${channelId}/bans/${userId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["bans", channelId] }),
  });

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-panel2 rounded-lg w-full max-w-lg max-h-[80vh] flex flex-col shadow-2xl">
        <div className="flex items-center justify-between p-4 border-b border-panel">
          <h2 className="text-lg font-semibold">Список банов</h2>
          <button onClick={onClose} className="text-muted hover:text-text text-xl leading-none">
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {isLoading ? (
            <div className="text-muted text-sm">Загрузка…</div>
          ) : bans.length === 0 ? (
            <div className="text-muted text-sm">Забаненных нет.</div>
          ) : (
            bans.map((b) => (
              <div key={b.id} className="bg-panel rounded p-3 flex items-center gap-2">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-mono truncate">{b.user_id.slice(0, 12)}…</div>
                  {b.reason && <div className="text-xs text-muted">{b.reason}</div>}
                  <div className="text-[10px] text-muted">
                    {new Date(b.created_at).toLocaleString()}
                  </div>
                </div>
                <button
                  onClick={() => unban.mutate(b.user_id)}
                  className="bg-accent text-sm px-3 py-1 rounded shrink-0"
                >
                  Разбанить
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
