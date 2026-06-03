import { useState, useEffect } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useAuthStore } from "../store/auth";
import Avatar from "../components/Avatar";

interface Profile {
  user_id: string;
  username: string;
  display_name: string | null;
  status: string;
  bio: string | null;
  created_at: string;
}

/**
 * Profile page. When userId === me, show editable fields; otherwise show a
 * read-only view with a "Send DM" action. Username and creation date are
 * always read-only.
 */
export default function ProfilePage() {
  const { userId } = useParams<{ userId: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const myId = useAuthStore((s) => s.userId);
  // The "me" route uses sentinel `:userId = "me"`; resolve to actual id.
  const targetId = userId === "me" ? myId : userId;
  const isMe = targetId === myId;

  const { data: profile, isLoading, error } = useQuery<Profile>({
    queryKey: ["profile", targetId],
    queryFn: async () => (await api.get<Profile>(`/users/${targetId}`)).data,
    enabled: !!targetId,
  });

  // Local edit state, seeded from the loaded profile.
  const [displayName, setDisplayName] = useState("");
  const [bio, setBio] = useState("");
  const [saveMsg, setSaveMsg] = useState("");

  useEffect(() => {
    if (profile) {
      setDisplayName(profile.display_name || "");
      setBio(profile.bio || "");
    }
  }, [profile]);

  const updateProfile = useMutation({
    mutationFn: async (patch: Partial<Profile>) =>
      (await api.patch<Profile>(`/users/me`, patch)).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["profile", targetId] });
      setSaveMsg("Сохранено");
      setTimeout(() => setSaveMsg(""), 2000);
    },
    onError: (e: any) =>
      setSaveMsg(e?.response?.data?.detail || "Не удалось сохранить"),
  });

  if (isLoading) {
    return <div className="p-8 text-muted">Загрузка профиля…</div>;
  }
  if (error || !profile) {
    return (
      <div className="p-8 space-y-2">
        <div className="text-red-400">Профиль не найден</div>
        <Link to="/" className="text-accent text-sm">
          ← на главную
        </Link>
      </div>
    );
  }

  const seed = profile.user_id;
  const displayed = profile.display_name || profile.username;

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-2xl mx-auto p-8 space-y-6">

      <div className="flex items-center gap-4">
        <Avatar seed={seed} name={displayed} size={96} />
        <div className="flex-1">
          <div className="text-2xl font-semibold">{displayed}</div>
          <div className="text-muted text-sm">@{profile.username}</div>
          <div className="text-xs text-muted mt-1">
            Зарегистрирован: {new Date(profile.created_at).toLocaleDateString()}
          </div>
        </div>
      </div>

      {/* Bio */}
      <div>
        <div className="text-xs uppercase text-muted mb-1">О себе</div>
        {isMe ? (
          <textarea
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            maxLength={500}
            placeholder="Расскажите о себе…"
            className="w-full bg-bg border border-panel2 rounded p-2 text-sm min-h-[100px]"
          />
        ) : (
          <div className="bg-panel rounded p-3 text-sm whitespace-pre-wrap min-h-[60px]">
            {profile.bio || <span className="text-muted">Пока ничего</span>}
          </div>
        )}
      </div>

      {/* Display name (editable for me) */}
      {isMe && (
        <div>
          <div className="text-xs uppercase text-muted mb-1">Отображаемое имя</div>
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            maxLength={100}
            placeholder="Как вас называть"
            className="w-full bg-bg border border-panel2 rounded p-2 text-sm"
          />
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-3">
        {isMe ? (
          <>
            <button
              onClick={() =>
                updateProfile.mutate({
                  display_name: displayName || null,
                  bio: bio || null,
                })
              }
              disabled={updateProfile.isPending}
              className="bg-accent px-4 py-2 rounded text-sm disabled:opacity-50"
            >
              Сохранить
            </button>
            {saveMsg && <span className="text-muted text-sm">{saveMsg}</span>}
          </>
        ) : (
          <button
            onClick={() => navigate(`/dm/${profile.user_id}`)}
            className="bg-accent px-4 py-2 rounded text-sm"
          >
            Написать сообщение
          </button>
        )}
      </div>
      </div>
    </div>
  );
}
