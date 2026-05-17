import { useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { useAuthStore } from "../store/auth";

export default function InvitePage() {
  const { code } = useParams();
  const navigate = useNavigate();
  const token = useAuthStore((s) => s.accessToken);

  useEffect(() => {
    if (!token) {
      navigate(`/login?next=/invite/${code}`);
      return;
    }
    if (!code) return;
    (async () => {
      try {
        const { data } = await api.post(`/invites/${code}/accept`);
        navigate(`/channels/${data.channel_id}`);
      } catch {
        navigate("/");
      }
    })();
  }, [code, token, navigate]);

  return <div className="min-h-screen flex items-center justify-center">Joining...</div>;
}
