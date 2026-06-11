import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api";
import { useAuthStore } from "../store/auth";
import { ensureIdentityKey, exportPublicKey } from "../crypto";
import { validateEmail } from "../validation";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const setTokens = useAuthStore((s) => s.setTokens);
  const setUserId = useAuthStore((s) => s.setUserId);

  // Validate email on blur to avoid yelling at the user while they're still
  // typing. submit() runs the same check defensively in case they bypass blur.
  function onEmailBlur() {
    setEmailError(email ? validateEmail(email) : null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    const emailMsg = validateEmail(email);
    if (emailMsg) {
      setEmailError(emailMsg);
      return;
    }

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
      setError(err?.response?.data?.detail || "Не удалось войти");
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
        <h1 className="text-2xl font-semibold">Вход</h1>
        <div>
          <label className="block text-sm text-muted mb-1">Email</label>
          <input
            className="w-full bg-bg p-2 rounded border border-panel2"
            type="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              if (emailError) setEmailError(null);
            }}
            onBlur={onEmailBlur}
            autoComplete="email"
            required
          />
          {emailError && (
            <div className="text-red-400 text-xs mt-1">{emailError}</div>
          )}
        </div>
        <div>
          <label className="block text-sm text-muted mb-1">Пароль</label>
          <input
            className="w-full bg-bg p-2 rounded border border-panel2"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </div>
        {error && <div className="text-red-400 text-sm">{error}</div>}
        <button
          type="submit"
          disabled={loading || !!emailError}
          className="w-full bg-accent py-2 rounded font-medium disabled:opacity-50"
        >
          {loading ? "Входим…" : "Войти"}
        </button>
        <div className="text-sm text-muted text-center">
          Нет аккаунта? <Link to="/register" className="text-accent">Регистрация</Link>
        </div>
      </form>
    </div>
  );
}
