import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import ChatRoom from "../components/ChatRoom";
import VoiceRoom from "../components/VoiceRoom";
import RoleManager from "../components/RoleManager";
import MemberActions from "../components/MemberActions";
import BanList from "../components/BanList";
import Avatar from "../components/Avatar";
import { useMemberRoles } from "../hooks/useMemberRoles";
import { useMyPermissions } from "../hooks/useMyPermissions";
import { useWebSocket } from "../hooks/useWebSocket";

interface Channel {
  id: string;
  name: string;
  description: string | null;
  owner_id: string;
}

interface Room {
  id: string;
  channel_id: string;
  name: string;
  room_type: "text" | "voice";
}

interface Member {
  id: string;
  user_id: string;
  nickname: string | null;
  muted: boolean;
}

export default function ChannelPage() {
  const { channelId, roomId } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [showInvite, setShowInvite] = useState(false);
  const [inviteCode, setInviteCode] = useState<string | null>(null);
  const [newRoomName, setNewRoomName] = useState("");
  const [newRoomType, setNewRoomType] = useState<"text" | "voice">("text");
  const [showRoles, setShowRoles] = useState(false);
  const [showBans, setShowBans] = useState(false);

  const { perms: myPerms, can } = useMyPermissions(channelId);

  const { data: channel } = useQuery({
    queryKey: ["channel", channelId],
    queryFn: async () => (await api.get<Channel>(`/channels/${channelId}`)).data,
    enabled: !!channelId,
  });

  const { data: rooms = [] } = useQuery({
    queryKey: ["rooms", channelId],
    queryFn: async () => (await api.get<Room[]>(`/channels/${channelId}/rooms`)).data,
    enabled: !!channelId,
  });

  const { data: members = [] } = useQuery({
    queryKey: ["members", channelId],
    queryFn: async () => (await api.get<Member[]>(`/channels/${channelId}/members`)).data,
    enabled: !!channelId,
  });

  // Resolve member -> profile so we can show usernames + initials instead of
  // raw uuids. One small request per member; with realistic channel sizes
  // (<200) this is fine. Keyed by the concatenated id list so React Query
  // refetches when the membership actually changes.
  interface Profile {
    user_id: string;
    username: string;
    display_name: string | null;
  }
  const { data: memberProfiles = {} } = useQuery<Record<string, Profile>>({
    queryKey: [
      "member-profiles",
      channelId,
      members.map((m) => m.user_id).sort().join(","),
    ],
    enabled: members.length > 0,
    queryFn: async () => {
      const out: Record<string, Profile> = {};
      await Promise.all(
        members.map(async (m) => {
          try {
            const { data } = await api.get<Profile>(`/users/${m.user_id}`);
            out[m.user_id] = data;
          } catch {
            /* user-service unavailable or profile missing — fall back to uuid */
          }
        })
      );
      return out;
    },
  });

  const { data: roleInfo = {} } = useMemberRoles(channelId);

  // Refresh members list when someone joins the channel I'm in. The server
  // already publishes member.joined on each existing member's user channel
  // (used for sender-key redistribution); we hook into the same event here
  // so the right-side roster updates without a page reload.
  useWebSocket((ev) => {
    if (!channelId) return;
    if (
      (ev.type === "member.joined" || ev.type === "member.left") &&
      ev.data?.channel_id === channelId
    ) {
      qc.invalidateQueries({ queryKey: ["members", channelId] });
      qc.invalidateQueries({ queryKey: ["memberRoleInfo", channelId] });
    }
  });

  // Auto-select first text room if none chosen
  useEffect(() => {
    if (!roomId && rooms.length > 0) {
      const first = rooms.find((r) => r.room_type === "text") || rooms[0];
      navigate(`/channels/${channelId}/rooms/${first.id}`, { replace: true });
    }
  }, [roomId, rooms, channelId, navigate]);

  const currentRoom = rooms.find((r) => r.id === roomId);

  async function createInvite() {
    const { data } = await api.post(`/channels/${channelId}/invites`, {
      ttl_seconds: 86400,
    });
    setInviteCode(data.code);
    setShowInvite(true);
  }

  async function createRoom() {
    if (!newRoomName.trim()) return;
    await api.post(`/channels/${channelId}/rooms`, {
      name: newRoomName,
      room_type: newRoomType,
    });
    setNewRoomName("");
    qc.invalidateQueries({ queryKey: ["rooms", channelId] });
  }

  async function deleteRoom(roomIdToDelete: string) {
    if (!confirm("Удалить эту комнату? Действие необратимо.")) return;
    await api.delete(`/channels/${channelId}/rooms/${roomIdToDelete}`);
    qc.invalidateQueries({ queryKey: ["rooms", channelId] });
    // If we deleted the room we're viewing, go back to the channel root.
    if (roomIdToDelete === roomId) navigate(`/channels/${channelId}`);
  }

  async function deleteChannel() {
    if (!confirm("Удалить весь канал со всеми комнатами и сообщениями? Необратимо.")) return;
    await api.delete(`/channels/${channelId}`);
    navigate("/");
  }

  return (
    <div className="h-full flex">
      {/* Sidebar */}
      <aside className="w-64 bg-panel flex flex-col">
        <div className="p-4 border-b border-panel2">
          <Link to="/" className="text-sm text-muted hover:text-text">
            ← Все каналы
          </Link>
          <h2 className="font-semibold mt-2 truncate">{channel?.name || "..."}</h2>
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          <div className="text-xs uppercase text-muted px-2 py-1">Текстовые комнаты</div>
          {rooms
            .filter((r) => r.room_type === "text")
            .map((r) => (
              <div key={r.id} className="flex items-center group">
                <Link
                  to={`/channels/${channelId}/rooms/${r.id}`}
                  className={`flex-1 px-2 py-1 rounded text-sm hover:bg-panel2 truncate ${
                    r.id === roomId ? "bg-panel2" : ""
                  }`}
                >
                  # {r.name}
                </Link>
                {can("MANAGE_CHANNELS") && (
                  <button
                    onClick={() => deleteRoom(r.id)}
                    className="opacity-0 group-hover:opacity-100 text-muted hover:text-red-400 px-1"
                    title="Удалить комнату"
                  >
                    ✕
                  </button>
                )}
              </div>
            ))}

          <div className="text-xs uppercase text-muted px-2 py-1 mt-3">Голосовые комнаты</div>
          {rooms
            .filter((r) => r.room_type === "voice")
            .map((r) => (
              <div key={r.id} className="flex items-center group">
                <Link
                  to={`/channels/${channelId}/rooms/${r.id}`}
                  className={`flex-1 px-2 py-1 rounded text-sm hover:bg-panel2 truncate ${
                    r.id === roomId ? "bg-panel2" : ""
                  }`}
                >
                  🔊 {r.name}
                </Link>
                {can("MANAGE_CHANNELS") && (
                  <button
                    onClick={() => deleteRoom(r.id)}
                    className="opacity-0 group-hover:opacity-100 text-muted hover:text-red-400 px-1"
                    title="Удалить комнату"
                  >
                    ✕
                  </button>
                )}
              </div>
            ))}

          {can("MANAGE_CHANNELS") && (
            <div className="mt-4 p-2 bg-bg rounded space-y-2">
              <input
                value={newRoomName}
                onChange={(e) => setNewRoomName(e.target.value)}
                placeholder="Название новой комнаты"
              className="w-full bg-panel p-1 text-sm rounded"
            />
            <select
              value={newRoomType}
              onChange={(e) => setNewRoomType(e.target.value as any)}
              className="w-full bg-panel p-1 text-sm rounded"
            >
              <option value="text">text</option>
              <option value="voice">voice</option>
            </select>
            <button onClick={createRoom} className="w-full bg-accent text-sm py-1 rounded">
              + Создать комнату
            </button>
            </div>
          )}
        </div>

        <div className="p-2 border-t border-panel2 space-y-1">
          {can("MANAGE_ROLES") && (
            <button
              onClick={() => setShowRoles(true)}
              className="w-full bg-panel2 text-sm py-1 rounded"
            >
              Управление ролями
            </button>
          )}
          {can("BAN_MEMBERS") && (
            <button
              onClick={() => setShowBans(true)}
              className="w-full bg-panel2 text-sm py-1 rounded"
            >
              Список банов
            </button>
          )}
          {can("CREATE_INVITE") && (
            <button
              onClick={createInvite}
              className="w-full bg-panel2 text-sm py-1 rounded"
            >
              Создать приглашение
            </button>
          )}
          {showInvite && inviteCode && (
            <div className="mt-2 p-2 bg-bg rounded text-xs">
              <div className="text-muted">Код (действует 24ч):</div>
              <div className="font-mono break-all">{inviteCode}</div>
            </div>
          )}
          {myPerms?.is_owner && (
            <button
              onClick={deleteChannel}
              className="w-full bg-red-600/80 hover:bg-red-600 text-sm py-1 rounded mt-2"
            >
              Удалить канал
            </button>
          )}
        </div>
      </aside>

      {showRoles && (
        <RoleManager channelId={channelId!} onClose={() => setShowRoles(false)} />
      )}
      {showBans && (
        <BanList channelId={channelId!} onClose={() => setShowBans(false)} />
      )}

      {/* Main */}
      <main className="flex-1 flex flex-col">
        <header className="bg-panel p-4 border-b border-panel2">
          <h2 className="font-semibold">
            {currentRoom ? (currentRoom.room_type === "text" ? `# ${currentRoom.name}` : `🔊 ${currentRoom.name}`) : "Select a room"}
          </h2>
        </header>

        <div className="flex-1 overflow-hidden">
          {currentRoom?.room_type === "text" && (
            <ChatRoom
              key={currentRoom.id}
              roomId={currentRoom.id}
              channelId={channelId!}
            />
          )}
          {currentRoom?.room_type === "voice" && (
            <div className="p-4">
              {/* `key` forces a full remount on room change so LiveKit
                  session, AudioContext, mic state etc. get a clean slate.
                  Without it the component just gets new props and we leak
                  the previous connection — especially noticeable when
                  a moderator moves us between voice rooms. */}
              <VoiceRoom
                key={currentRoom.id}
                roomId={currentRoom.id}
                channelId={channelId!}
              />
            </div>
          )}
        </div>
      </main>

      {/* Members panel */}
      <aside className="w-56 bg-panel border-l border-panel2 p-4 overflow-y-auto">
        <div className="text-xs uppercase text-muted mb-2">Участники ({members.length})</div>
        {members.map((m) => {
          const role = roleInfo[m.user_id]?.topRole;
          // Hierarchy: I can act on a member only if my rank strictly exceeds
          // theirs (owner outranks all; nobody outranks the owner).
          const targetRank = role?.position ?? 0;
          const targetIsOwner = m.user_id === channel?.owner_id;
          const myRank = myPerms?.is_owner ? Number.MAX_SAFE_INTEGER : myPerms?.rank ?? 0;
          const actionable =
            !targetIsOwner && (myPerms?.is_owner || myRank > targetRank);

          return (
            <div key={m.id} className="text-sm py-1 flex items-center gap-2 group">
              <Avatar
                seed={m.user_id}
                name={
                  memberProfiles[m.user_id]?.display_name ||
                  memberProfiles[m.user_id]?.username ||
                  m.user_id
                }
                size={24}
              />
              <span
                style={role?.color ? { color: role.color } : undefined}
                className="truncate min-w-0"
              >
                {/* Prefer channel nickname → display_name → username → uuid */}
                {m.nickname ||
                  memberProfiles[m.user_id]?.display_name ||
                  memberProfiles[m.user_id]?.username ||
                  m.user_id.slice(0, 8)}
              </span>
              {role && (
                <span
                  className="px-1 rounded text-[10px] shrink-0"
                  style={{
                    backgroundColor: (role.color || "#979c9f") + "33",
                    color: role.color || "#979c9f",
                  }}
                >
                  {role.name}
                </span>
              )}
              {m.muted && <span className="text-muted text-xs shrink-0">🔇</span>}
              <span className="ml-auto">
                <MemberActions
                  channelId={channelId!}
                  member={m}
                  canKick={can("KICK_MEMBERS")}
                  canBan={can("BAN_MEMBERS")}
                  canMute={can("MUTE_MEMBERS")}
                  actionable={!!actionable}
                />
              </span>
            </div>
          );
        })}
      </aside>
    </div>
  );
}
