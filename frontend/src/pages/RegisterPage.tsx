import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api";
import { useAuthStore } from "../store/auth";
import { ensureIdentityKey, exportPublicKey } from "../crypto";

export default function RegisterPage() {
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const setTokens = useAuthStore((s) => s.setTokens);
  const setUserId = useAuthStore((s) => s.setUserId);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const { data } = await api.post("/auth/register", { email, username, password });
      setTokens(data.access_token, data.refresh_token);

      const me = await api.get("/auth/me");
      setUserId(me.data.id);

      // Initialize profile in user-service
      try {
        await api.post("/users/profile/init", { user_id: me.data.id, username: me.data.username });
      } catch {
        // profile may already exist
      }

      // Generate identity ECDH key, upload public part
      const kp = await ensureIdentityKey();
      const pub = await exportPublicKey(kp.publicKey);
      await api.post("/auth/keys", { key_type: "ecdh", key_data: pub });

      navigate("/");
    } catch (err: any) {
      setError(err?.response?.data?.detail || "Registration failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center">
      <form onSubmit={submit} className="bg-panel p-8 rounded-lg w-full max-w-sm space-y-4">
        <h1 className="text-2xl font-semibold">Create account</h1>
        <div>
          <label className="block text-sm text-muted mb-1">Email</label>
          <input
            className="w-full bg-bg p-2 rounded border border-panel2"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <div>
          <label className="block text-sm text-muted mb-1">Username</label>
          <input
            className="w-full bg-bg p-2 rounded border border-panel2"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            pattern="^[a-zA-Z0-9_]+$"
            minLength={3}
            maxLength={50}
            required
          />
        </div>
        <div>
          <label className="block text-sm text-muted mb-1">Password</label>
          <input
            className="w-full bg-bg p-2 rounded border border-panel2"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={8}
            required
          />
        </div>
        {error && <div className="text-red-400 text-sm">{error}</div>}
        <button
          type="submit"
          disabled={loading}
          className="w-full bg-accent py-2 rounded font-medium disabled:opacity-50"
        >
          {loading ? "Creating..." : "Register"}
        </button>
        <div className="text-sm text-muted text-center">
          Already have one? <Link to="/login" className="text-accent">Sign in</Link>
        </div>
      </form>
    </div>
  );
}
