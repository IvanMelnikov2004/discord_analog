import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import ChatRoom from "../components/ChatRoom";
import VoiceRoom from "../components/VoiceRoom";

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

  return (
    <div className="h-screen flex">
      {/* Sidebar */}
      <aside className="w-64 bg-panel flex flex-col">
        <div className="p-4 border-b border-panel2">
          <Link to="/" className="text-sm text-muted hover:text-text">
            ← All channels
          </Link>
          <h2 className="font-semibold mt-2 truncate">{channel?.name || "..."}</h2>
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          <div className="text-xs uppercase text-muted px-2 py-1">Text rooms</div>
          {rooms
            .filter((r) => r.room_type === "text")
            .map((r) => (
              <Link
                key={r.id}
                to={`/channels/${channelId}/rooms/${r.id}`}
                className={`block px-2 py-1 rounded text-sm hover:bg-panel2 ${
                  r.id === roomId ? "bg-panel2" : ""
                }`}
              >
                # {r.name}
              </Link>
            ))}

          <div className="text-xs uppercase text-muted px-2 py-1 mt-3">Voice rooms</div>
          {rooms
            .filter((r) => r.room_type === "voice")
            .map((r) => (
              <Link
                key={r.id}
                to={`/channels/${channelId}/rooms/${r.id}`}
                className={`block px-2 py-1 rounded text-sm hover:bg-panel2 ${
                  r.id === roomId ? "bg-panel2" : ""
                }`}
              >
                🔊 {r.name}
              </Link>
            ))}

          <div className="mt-4 p-2 bg-bg rounded space-y-2">
            <input
              value={newRoomName}
              onChange={(e) => setNewRoomName(e.target.value)}
              placeholder="New room name"
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
              + Create room
            </button>
          </div>
        </div>

        <div className="p-2 border-t border-panel2">
          <button
            onClick={createInvite}
            className="w-full bg-panel2 text-sm py-1 rounded"
          >
            Create invite
          </button>
          {showInvite && inviteCode && (
            <div className="mt-2 p-2 bg-bg rounded text-xs">
              <div className="text-muted">Code (valid 24h):</div>
              <div className="font-mono break-all">{inviteCode}</div>
            </div>
          )}
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 flex flex-col">
        <header className="bg-panel p-4 border-b border-panel2">
          <h2 className="font-semibold">
            {currentRoom ? (currentRoom.room_type === "text" ? `# ${currentRoom.name}` : `🔊 ${currentRoom.name}`) : "Select a room"}
          </h2>
        </header>

        <div className="flex-1 overflow-hidden">
          {currentRoom?.room_type === "text" && <ChatRoom roomId={currentRoom.id} />}
          {currentRoom?.room_type === "voice" && (
            <div className="p-4">
              <VoiceRoom roomId={currentRoom.id} />
            </div>
          )}
        </div>
      </main>

      {/* Members panel */}
      <aside className="w-56 bg-panel border-l border-panel2 p-4 overflow-y-auto">
        <div className="text-xs uppercase text-muted mb-2">Members ({members.length})</div>
        {members.map((m) => (
          <div key={m.id} className="text-sm py-1">
            {m.nickname || m.user_id.slice(0, 8)}
            {m.muted && <span className="text-muted text-xs ml-1">(muted)</span>}
          </div>
        ))}
      </aside>
    </div>
  );
}
