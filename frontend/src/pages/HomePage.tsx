import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";

/**
 * Home / landing view inside the authenticated shell.
 *
 * The sidebar already lists channels and DMs, so this page is now a
 * "what next" landing: create a channel or accept an invite. Picking a
 * channel/DM from the sidebar is the primary navigation path.
 */
export default function HomePage() {
  const navigate = useNavigate();
  const qc = useQueryClient();

  const [name, setName] = useState("");
  const [joinCode, setJoinCode] = useState("");

  const createChannel = useMutation({
    mutationFn: async (n: string) =>
      (await api.post("/channels", { name: n })).data,
    onSuccess: (data: any) => {
      qc.invalidateQueries({ queryKey: ["channels"] });
      setName("");
      if (data?.id) navigate(`/channels/${data.id}`);
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
    <div className="h-full overflow-y-auto">
      <div className="max-w-2xl mx-auto p-8 space-y-8">
        <div>
          <h1 className="text-2xl font-semibold mb-2">Добро пожаловать</h1>
          <p className="text-muted">
            Выберите канал или диалог слева, или создайте новый канал.
          </p>
        </div>

        <section>
          <h2 className="text-lg font-medium mb-3">Создать канал</h2>
          <div className="flex gap-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Название канала"
              className="flex-1 bg-bg p-2 rounded border border-panel2"
              onKeyDown={(e) =>
                e.key === "Enter" && name && createChannel.mutate(name)
              }
            />
            <button
              onClick={() => name && createChannel.mutate(name)}
              disabled={!name || createChannel.isPending}
              className="bg-accent px-4 rounded disabled:opacity-50"
            >
              Создать
            </button>
          </div>
        </section>

        <section>
          <h2 className="text-lg font-medium mb-3">
            Присоединиться по приглашению
          </h2>
          <div className="flex gap-2">
            <input
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value)}
              placeholder="Код приглашения"
              className="flex-1 bg-bg p-2 rounded border border-panel2"
              onKeyDown={(e) =>
                e.key === "Enter" && joinCode && acceptInvite.mutate(joinCode)
              }
            />
            <button
              disabled={!joinCode || acceptInvite.isPending}
              onClick={() => acceptInvite.mutate(joinCode)}
              className="bg-accent px-4 rounded disabled:opacity-50"
            >
              Войти
            </button>
          </div>
          {acceptInvite.isError && (
            <div className="text-red-400 text-sm mt-2">
              {(acceptInvite.error as any)?.response?.data?.detail ||
                "Не удалось"}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
