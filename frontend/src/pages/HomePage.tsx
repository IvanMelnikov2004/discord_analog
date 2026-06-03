import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useAuthStore } from "../store/auth";
import Avatar from "../components/Avatar";

interface Channel {
  id: string;
  name: string;
  description: string | null;
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

export default function HomePage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const myId = useAuthStore((s) => s.userId);
  const logout = useAuthStore((s) => s.logout);

  const [name, setName] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  const [dmUsername, setDmUsername] = useState("");
  const [dmError, setDmError] = useState("");

  const { data: channels = [], isLoading } = useQuery({
    queryKey: ["channels"],
    queryFn: async () => (await api.get<Channel[]>("/channels")).data,
  });

  const { data: me } = useQuery<Profile>({
    queryKey: ["profile", myId],
    queryFn: async () => (await api.get<Profile>(`/users/${myId}`)).data,
    enabled: !!myId,
  });

  // DM conversations (partners I've talked to). Empty until you start a DM.
  const { data: conversations = [] } = useQuery<Conversation[]>({
    queryKey: ["dm-conversations"],
    queryFn: async () =>
      (await api.get<Conversation[]>("/messages/dm-conversations")).data,
  });

  // Lookup partner profiles in bulk for the conversation list. One small
  // request per partner — fine for MVP (typical <20 entries).
  const { data: partnerProfiles = {} } = useQuery<Record<string, Profile>>({
    queryKey: ["dm-partner-profiles", conversations.map((c) => c.partner_id).join(",")],
    enabled: conversations.length > 0,
    queryFn: async () => {
      const out: Record<string, Profile> = {};
      await Promise.all(
        conversations.map(async (c) => {
          try {
            const { data } = await api.get<Profile>(`/users/${c.partner_id}`);
            out[c.partner_id] = data;
          } catch {
            /* keep going */
          }
        })
      );
      return out;
    },
  });

  const createChannel = useMutation({
    mutationFn: async (n: string) => (await api.post("/channels", { name: n })).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["channels"] });
      setName("");
      setShowCreate(false);
    },
  });

  const acceptInvite = useMutation({
    mutationFn: async (code: string) =>
      (await api.post(`/invites/${code}/accept`)).data,
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["channels"] });
      setJoinCode("");
      navigate(`/channels/${data.channel_id}`);
    },
  });

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
      setDmError(e?.response?.data?.detail || "Пользователь не найден");
    }
  }

  const myName = me?.display_name || me?.username || "вы";

  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-panel p-4 flex justify-between items-center">
        <h1 className="text-xl font-semibold">Messenger</h1>
        <div className="flex items-center gap-3">
          <Link
            to="/profile/me"
            className="flex items-center gap-2 hover:bg-panel2 px-2 py-1 rounded"
          >
            {myId && <Avatar seed={myId} name={myName} size={28} />}
            <span className="text-sm">{myName}</span>
          </Link>
          <button
            onClick={() => {
              logout();
              navigate("/login");
            }}
            className="text-sm text-muted hover:text-text"
          >
            Выйти
          </button>
        </div>
      </header>

      <main className="flex-1 p-6 max-w-3xl mx-auto w-full space-y-6">
        {/* Channels */}
        <section>
          <div className="flex justify-between items-center mb-3">
            <h2 className="text-lg font-medium">Ваши каналы</h2>
            <button
              onClick={() => setShowCreate(!showCreate)}
              className="bg-accent text-sm px-3 py-1 rounded"
            >
              + Новый канал
            </button>
          </div>

          {showCreate && (
            <div className="bg-panel p-4 rounded mb-3 flex gap-2">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Название канала"
                className="flex-1 bg-bg p-2 rounded border border-panel2"
              />
              <button
                onClick={() => name && createChannel.mutate(name)}
                className="bg-accent px-4 rounded"
              >
                Создать
              </button>
            </div>
          )}

          {isLoading ? (
            <div className="text-muted">Загрузка…</div>
          ) : channels.length === 0 ? (
            <div className="text-muted">
              Пока нет каналов. Создайте новый или присоединитесь по приглашению.
            </div>
          ) : (
            <ul className="space-y-2">
              {channels.map((c) => (
                <li key={c.id}>
                  <Link
                    to={`/channels/${c.id}`}
                    className="block bg-panel p-3 rounded hover:bg-panel2"
                  >
                    <div className="font-medium">{c.name}</div>
                    {c.description && (
                      <div className="text-sm text-muted">{c.description}</div>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Direct Messages */}
        <section>
          <h2 className="text-lg font-medium mb-3">Личные сообщения</h2>

          <div className="bg-panel p-3 rounded mb-3">
            <div className="text-xs uppercase text-muted mb-2">
              Написать пользователю
            </div>
            <div className="flex gap-2">
              <input
                value={dmUsername}
                onChange={(e) => setDmUsername(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && startDmByUsername()}
                placeholder="@username"
                className="flex-1 bg-bg p-2 rounded border border-panel2"
              />
              <button
                onClick={startDmByUsername}
                className="bg-accent px-4 rounded text-sm"
              >
                Написать
              </button>
            </div>
            {dmError && (
              <div className="text-red-400 text-sm mt-2">{dmError}</div>
            )}
          </div>

          {conversations.length === 0 ? (
            <div className="text-muted text-sm">
              Здесь будут ваши диалоги.
            </div>
          ) : (
            <ul className="space-y-2">
              {conversations.map((c) => {
                const p = partnerProfiles[c.partner_id];
                const displayed = p?.display_name || p?.username || c.partner_id.slice(0, 8);
                return (
                  <li key={c.partner_id}>
                    <Link
                      to={`/dm/${c.partner_id}`}
                      className="flex items-center gap-3 bg-panel p-3 rounded hover:bg-panel2"
                    >
                      <Avatar seed={c.partner_id} name={displayed} size={36} />
                      <div className="flex-1 min-w-0">
                        <div className="font-medium truncate">{displayed}</div>
                        {p?.username && (
                          <div className="text-xs text-muted">@{p.username}</div>
                        )}
                      </div>
                      <div className="text-xs text-muted shrink-0">
                        {new Date(c.last_at).toLocaleDateString()}
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* Invite */}
        <section>
          <h2 className="text-lg font-medium mb-3">Присоединиться по приглашению</h2>
          <div className="flex gap-2">
            <input
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value)}
              placeholder="Код приглашения"
              className="flex-1 bg-bg p-2 rounded border border-panel2"
            />
            <button
              disabled={!joinCode || acceptInvite.isPending}
              onClick={() => acceptInvite.mutate(joinCode)}
              className="bg-accent px-4 rounded disabled:opacity-50"
            >
              Присоединиться
            </button>
          </div>
          {acceptInvite.isError && (
            <div className="text-red-400 text-sm mt-2">
              {(acceptInvite.error as any)?.response?.data?.detail || "Не удалось"}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
