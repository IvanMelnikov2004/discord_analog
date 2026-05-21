import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api";
import { useAuthStore } from "../store/auth";
import { ensureIdentityKey, exportPublicKey } from "../crypto";

export default function LoginPage() {
  const [email, setEmail] = useState("");
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
      const { data } = await api.post("/auth/login", { email, password });
      setTokens(data.access_token, data.refresh_token);

      const me = await api.get("/auth/me");
      setUserId(me.data.id);

      // Crypto is optional for getting in. If we're not in a secure context
      // (e.g. served over plain http://), skip key setup but still let the
      // user in — they'll see a clear warning when they try to chat/call.
      try {
        const kp = await ensureIdentityKey();
        const pub = await exportPublicKey(kp.publicKey);
        try {
          await api.post("/auth/keys", { key_type: "ecdh", key_data: pub });
        } catch {
          // already uploaded — ignore
        }
      } catch (cryptoErr) {
        console.warn("Crypto setup skipped:", cryptoErr);
      }

      navigate("/");
    } catch (err: any) {
      setError(err?.response?.data?.detail || "Login failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center">
      <form
        onSubmit={submit}
        className="bg-panel p-8 rounded-lg w-full max-w-sm space-y-4"
      >
        <h1 className="text-2xl font-semibold">Sign in</h1>
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
          <label className="block text-sm text-muted mb-1">Password</label>
          <input
            className="w-full bg-bg p-2 rounded border border-panel2"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
          />
        </div>
        {error && <div className="text-red-400 text-sm">{error}</div>}
        <button
          type="submit"
          disabled={loading}
          className="w-full bg-accent py-2 rounded font-medium disabled:opacity-50"
        >
          {loading ? "Signing in..." : "Sign in"}
        </button>
        <div className="text-sm text-muted text-center">
          No account? <Link to="/register" className="text-accent">Register</Link>
        </div>
      </form>
    </div>
  );
}
