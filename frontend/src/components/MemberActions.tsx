import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";

interface Member {
  id: string;
  user_id: string;
  nickname: string | null;
  muted: boolean;
}

interface Props {
  channelId: string;
  member: Member;
  canKick: boolean;
  canBan: boolean;
  canMute: boolean;
  /** Whether the current user is allowed to act on THIS member (hierarchy). */
  actionable: boolean;
}

/**
 * Small "⋯" menu with moderation actions for one member.
 * Buttons are shown only for permissions the actor holds; the whole menu is
 * hidden when the actor can't act on this member (hierarchy) or has no rights.
 */
export default function MemberActions({
  channelId,
  member,
  canKick,
  canBan,
  canMute,
  actionable,
}: Props) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [muteSubmenu, setMuteSubmenu] = useState(false);
  const [error, setError] = useState("");

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["members", channelId] });
    qc.invalidateQueries({ queryKey: ["memberRoleInfo", channelId] });
    qc.invalidateQueries({ queryKey: ["bans", channelId] });
  };

  const kick = useMutation({
    mutationFn: async () => api.delete(`/channels/${channelId}/members/${member.id}`),
    onSuccess: () => {
      invalidate();
      setOpen(false);
    },
    onError: (e: any) => setError(e?.response?.data?.detail || "Не удалось"),
  });

  const ban = useMutation({
    mutationFn: async () =>
      api.post(`/channels/${channelId}/bans`, { user_id: member.user_id }),
    onSuccess: () => {
      invalidate();
      setOpen(false);
    },
    onError: (e: any) => setError(e?.response?.data?.detail || "Не удалось"),
  });

  // duration_seconds=null/0 means "forever". Backend ignores it on unmute.
  const setMute = useMutation({
    mutationFn: async ({ on, durationSeconds }: { on: boolean; durationSeconds?: number }) => {
      const params = new URLSearchParams({ muted: String(on) });
      if (on && durationSeconds && durationSeconds > 0) {
        params.set("duration_seconds", String(durationSeconds));
      }
      return api.patch(`/channels/${channelId}/members/${member.id}/mute?${params}`);
    },
    onSuccess: () => {
      invalidate();
      setOpen(false);
      setMuteSubmenu(false);
    },
    onError: (e: any) => setError(e?.response?.data?.detail || "Не удалось"),
  });

  if (!actionable || (!canKick && !canBan && !canMute)) return null;

  return (
    <div className="relative inline-block">
      <button
        onClick={() => setOpen((o) => !o)}
        className="text-muted hover:text-text px-1 leading-none"
        title="Действия модерации"
      >
        ⋯
      </button>
      {open && (
        <div className="absolute right-0 mt-1 w-40 bg-panel2 border border-panel rounded shadow-lg z-20 text-sm">
          {canMute &&
            (member.muted ? (
              <button
                onClick={() => setMute.mutate({ on: false })}
                className="block w-full text-left px-3 py-2 hover:bg-panel"
              >
                Размьютить
              </button>
            ) : (
              <div className="relative">
                <button
                  onClick={() => setMuteSubmenu((s) => !s)}
                  className="block w-full text-left px-3 py-2 hover:bg-panel"
                >
                  Замьютить ▸
                </button>
                {muteSubmenu && (
                  <div className="absolute right-full top-0 mr-1 w-36 bg-panel2 border border-panel rounded shadow-lg text-sm">
                    {[
                      { label: "10 минут", s: 600 },
                      { label: "1 час", s: 3600 },
                      { label: "1 день", s: 86400 },
                      { label: "7 дней", s: 604800 },
                      { label: "Навсегда", s: 0 },
                    ].map((opt) => (
                      <button
                        key={opt.label}
                        onClick={() =>
                          setMute.mutate({ on: true, durationSeconds: opt.s })
                        }
                        className="block w-full text-left px-3 py-2 hover:bg-panel"
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          {canKick && (
            <button
              onClick={() => kick.mutate()}
              className="block w-full text-left px-3 py-2 hover:bg-panel text-amber-400"
            >
              Исключить
            </button>
          )}
          {canBan && (
            <button
              onClick={() => ban.mutate()}
              className="block w-full text-left px-3 py-2 hover:bg-panel text-red-400"
            >
              Забанить
            </button>
          )}
          {error && <div className="px-3 py-1 text-xs text-red-400">{error}</div>}
        </div>
      )}
    </div>
  );
}
