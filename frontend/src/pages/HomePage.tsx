import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useAuthStore } from "../store/auth";

interface Channel {
  id: string;
  name: string;
  description: string | null;
}

export default function HomePage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const logout = useAuthStore((s) => s.logout);
  const [name, setName] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [joinCode, setJoinCode] = useState("");

  const { data: channels = [], isLoading } = useQuery({
    queryKey: ["channels"],
    queryFn: async () => (await api.get<Channel[]>("/channels")).data,
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

  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-panel p-4 flex justify-between items-center">
        <h1 className="text-xl font-semibold">Messenger</h1>
        <button onClick={() => { logout(); navigate("/login"); }} className="text-sm text-muted hover:text-text">
          Sign out
        </button>
      </header>

      <main className="flex-1 p-6 max-w-3xl mx-auto w-full space-y-6">
        <section>
          <div className="flex justify-between items-center mb-3">
            <h2 className="text-lg font-medium">Your channels</h2>
            <button
              onClick={() => setShowCreate(!showCreate)}
              className="bg-accent text-sm px-3 py-1 rounded"
            >
              + New channel
            </button>
          </div>

          {showCreate && (
            <div className="bg-panel p-4 rounded mb-3 flex gap-2">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Channel name"
                className="flex-1 bg-bg p-2 rounded border border-panel2"
              />
              <button
                onClick={() => name && createChannel.mutate(name)}
                className="bg-accent px-4 rounded"
              >
                Create
              </button>
            </div>
          )}

          {isLoading ? (
            <div className="text-muted">Loading...</div>
          ) : channels.length === 0 ? (
            <div className="text-muted">No channels yet. Create one or join via invite.</div>
          ) : (
            <ul className="space-y-2">
              {channels.map((c) => (
                <li key={c.id}>
                  <Link
                    to={`/channels/${c.id}`}
                    className="block bg-panel p-3 rounded hover:bg-panel2"
                  >
                    <div className="font-medium">{c.name}</div>
                    {c.description && <div className="text-sm text-muted">{c.description}</div>}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h2 className="text-lg font-medium mb-3">Join with invite</h2>
          <div className="flex gap-2">
            <input
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value)}
              placeholder="Invite code"
              className="flex-1 bg-bg p-2 rounded border border-panel2"
            />
            <button
              disabled={!joinCode || acceptInvite.isPending}
              onClick={() => acceptInvite.mutate(joinCode)}
              className="bg-accent px-4 rounded disabled:opacity-50"
            >
              Join
            </button>
          </div>
          {acceptInvite.isError && (
            <div className="text-red-400 text-sm mt-2">
              {(acceptInvite.error as any)?.response?.data?.detail || "Failed"}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
