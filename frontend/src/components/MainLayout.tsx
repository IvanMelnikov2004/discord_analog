/**
 * Persistent Discord-style layout: a left sidebar (channels + DMs + profile)
 * plus an <Outlet /> for the active page on the right.
 *
 * Mounted as the parent route for every authenticated view, so the sidebar
 * survives navigations (no remount, no flicker, WS subscriptions on global
 * state keep working).
 */
import { useEffect, useState } from "react";
import { Link, Outlet, useLocation, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useAuthStore } from "../store/auth";
import { useWebSocket } from "../hooks/useWebSocket";
import Avatar from "./Avatar";

interface Channel {
  id: string;
  name: string;
}

interface Profile {
  user_id: string;
  username: string;
  display_name: string | null;
}

interface Conversation {
  partner_id: string;
  last_at: string;
}

export default function MainLayout() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const location = useLocation();
  const params = useParams();
  const myId = useAuthStore((s) => s.userId);
  const logout = useAuthStore((s) => s.logout);

  const [dmUsername, setDmUsername] = useState("");
  const [dmError, setDmError] = useState("");

  const { data: channels = [] } = useQuery({
    queryKey: ["channels"],
    queryFn: async () => (await api.get<Channel[]>("/channels")).data,
  });

  const { data: me } = useQuery<Profile>({
    queryKey: ["profile", myId],
    queryFn: async () => (await api.get<Profile>(`/users/${myId}`)).data,
    enabled: !!myId,
  });

  const { data: conversations = [] } = useQuery<Conversation[]>({
    queryKey: ["dm-conversations"],
    queryFn: async () =>
      (await api.get<Conversation[]>("/messages/dm-conversations")).data,
  });

  // Resolve display names for the DM list. Each profile fetch is small; bulk
  // them here so the sidebar shows nicknames instead of raw uuids.
  const { data: partnerProfiles = {} } = useQuery<Record<string, Profile>>({
    queryKey: [
      "dm-partner-profiles",
      conversations.map((c) => c.partner_id).join(","),
    ],
    enabled: conversations.length > 0,
    queryFn: async () => {
      const out: Record<string, Profile> = {};
      await Promise.all(
        conversations.map(async (c) => {
          try {
            const { data } = await api.get<Profile>(`/users/${c.partner_id}`);
            out[c.partner_id] = data;
          } catch {
            /* skip */
          }
        })
      );
      return out;
    },
  });

  // When a new DM arrives via the user-channel push, the conversation list
  // is stale — refetch so the new partner appears in the sidebar and the
  // existing rows reorder by last_at.
  useWebSocket((ev) => {
    if (ev.type === "message.new" && ev.data?.dm_pair) {
      qc.invalidateQueries({ queryKey: ["dm-conversations"] });
    }
  });

  // Active selection — highlight current channel/DM in the sidebar so the
  // user knows where they are. Falls back to nothing on Home.
  const activeChannel = params.channelId;
  const activePeer = location.pathname.startsWith("/dm/")
    ? location.pathname.split("/")[2]
    : undefined;

  async function startDmByUsername() {
    setDmError("");
    const u = dmUsername.trim().replace(/^@/, "");
    if (!u) return;
    try {
      const { data } = await api.get<Profile>(`/users/by-username/${u}`);
      if (data.user_id === myId) {
        setDmError("Это вы и есть");
        return;
      }
      setDmUsername("");
      navigate(`/dm/${data.user_id}`);
    } catch (e: any) {
      setDmError(e?.response?.data?.detail || "Не найден");
    }
  }

  const myName = me?.display_name || me?.username || "вы";

  return (
    <div className="h-screen flex overflow-hidden">
      {/* ===== Left sidebar ===== */}
      <aside className="w-64 bg-panel flex flex-col border-r border-panel2">
        <div className="p-3 border-b border-panel2">
          <Link
            to="/"
            className="text-sm font-semibold hover:underline"
          >
            🏠 Главная
          </Link>
        </div>

        {/* Channels */}
        <div className="px-3 pt-3 pb-1 text-xs uppercase text-muted">
          Каналы
        </div>
        <div className="flex-1 overflow-y-auto px-1 pb-1">
          {channels.length === 0 ? (
            <div className="px-2 py-1 text-xs text-muted">
              Нет каналов
            </div>
          ) : (
            channels.map((c) => (
              <Link
                key={c.id}
                to={`/channels/${c.id}`}
                className={`block px-2 py-1.5 rounded text-sm hover:bg-panel2 truncate ${
                  activeChannel === c.id ? "bg-panel2 font-medium" : ""
                }`}
              >
                # {c.name}
              </Link>
            ))
          )}

          {/* DMs */}
          <div className="px-1 pt-4 pb-1 text-xs uppercase text-muted">
            Личные сообщения
          </div>
          <div className="px-2 pb-2 space-y-1">
            <div className="flex gap-1">
              <input
                value={dmUsername}
                onChange={(e) => setDmUsername(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && startDmByUsername()}
                placeholder="@username"
                className="flex-1 bg-bg p-1 rounded text-xs border border-panel2"
              />
              <button
                onClick={startDmByUsername}
                className="bg-accent text-xs px-2 rounded"
              >
                +
              </button>
            </div>
            {dmError && (
              <div className="text-[10px] text-red-400">{dmError}</div>
            )}
          </div>
          {conversations.length === 0 ? (
            <div className="px-2 py-1 text-xs text-muted">
              Пока нет диалогов
            </div>
          ) : (
            conversations.map((c) => {
              const p = partnerProfiles[c.partner_id];
              const displayed =
                p?.display_name || p?.username || c.partner_id.slice(0, 8);
              return (
                <Link
                  key={c.partner_id}
                  to={`/dm/${c.partner_id}`}
                  className={`flex items-center gap-2 px-2 py-1.5 rounded text-sm hover:bg-panel2 ${
                    activePeer === c.partner_id ? "bg-panel2 font-medium" : ""
                  }`}
                >
                  <Avatar seed={c.partner_id} name={displayed} size={24} />
                  <span className="truncate">{displayed}</span>
                </Link>
              );
            })
          )}
        </div>

        {/* User strip */}
        <div className="border-t border-panel2 p-2 flex items-center gap-2">
          <Link
            to="/profile/me"
            className="flex items-center gap-2 flex-1 px-1 py-1 rounded hover:bg-panel2 min-w-0"
          >
            {myId && <Avatar seed={myId} name={myName} size={28} />}
            <span className="text-sm truncate">{myName}</span>
          </Link>
          <button
            onClick={() => {
              logout();
              navigate("/login");
            }}
            className="text-xs text-muted hover:text-text px-1"
            title="Выйти"
          >
            ⎋
          </button>
        </div>
      </aside>

      {/* ===== Main content ===== */}
      <main className="flex-1 min-w-0 overflow-hidden">
        <Outlet />
      </main>
    </div>
  );
}
