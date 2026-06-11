import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api";
import { useAuthStore } from "../store/auth";
import { ensureIdentityKey, exportPublicKey } from "../crypto";
import {
  checkPasswordRules,
  validateEmail,
  validatePassword,
} from "../validation";

export default function RegisterPage() {
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [usernameError, setUsernameError] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const setTokens = useAuthStore((s) => s.setTokens);
  const setUserId = useAuthStore((s) => s.setUserId);

  // Live per-rule feedback so the user sees which constraints they've met
  // as they type. Each row turns green once satisfied.
  const rules = checkPasswordRules(password);

  function onEmailBlur() {
    setEmailError(email ? validateEmail(email) : null);
  }
  function onUsernameBlur() {
    if (!username) {
      setUsernameError(null);
      return;
    }
    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      setUsernameError("Только латиница, цифры и подчёркивание");
    } else if (username.length < 3 || username.length > 50) {
      setUsernameError("Длина от 3 до 50 символов");
    } else {
      setUsernameError(null);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    // Defensive re-validation on submit so the user can't bypass via Enter
    // before blur has fired.
    const emailMsg = validateEmail(email);
    const passwordMsg = validatePassword(password);
    if (emailMsg) {
      setEmailError(emailMsg);
      return;
    }
    if (!username) {
      setUsernameError("Введите username");
      return;
    }
    if (usernameError) return;
    if (passwordMsg) {
      // Don't put password message in `error` — we have the live checklist.
      setError(passwordMsg);
      return;
    }

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

      // Generate identity ECDH key, upload public part.
      // Non-fatal: over plain http:// Web Crypto is unavailable, but the
      // account is already created — let the user in with a console warning.
      try {
        const kp = await ensureIdentityKey();
        const pub = await exportPublicKey(kp.publicKey);
        await api.post("/auth/keys", { key_type: "ecdh", key_data: pub });
      } catch (cryptoErr) {
        console.warn("Crypto setup skipped:", cryptoErr);
      }

      navigate("/");
    } catch (err: any) {
      setError(err?.response?.data?.detail || "Не удалось зарегистрироваться");
    } finally {
      setLoading(false);
    }
  }

  // True when ALL rules pass — used to disable submit. Server still checks
  // independently, this is just a usability gate.
  const passwordOk =
    rules.minLength && rules.hasUpper && rules.hasLower && rules.hasDigit;

  return (
    <div className="min-h-screen flex items-center justify-center">
      <form
        onSubmit={submit}
        className="bg-panel p-8 rounded-lg w-full max-w-sm space-y-4"
      >
        <h1 className="text-2xl font-semibold">Регистрация</h1>

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
          <label className="block text-sm text-muted mb-1">Username</label>
          <input
            className="w-full bg-bg p-2 rounded border border-panel2"
            value={username}
            onChange={(e) => {
              setUsername(e.target.value);
              if (usernameError) setUsernameError(null);
            }}
            onBlur={onUsernameBlur}
            pattern="^[a-zA-Z0-9_]+$"
            minLength={3}
            maxLength={50}
            autoComplete="username"
            required
          />
          {usernameError && (
            <div className="text-red-400 text-xs mt-1">{usernameError}</div>
          )}
        </div>

        <div>
          <label className="block text-sm text-muted mb-1">Пароль</label>
          <input
            className="w-full bg-bg p-2 rounded border border-panel2"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            required
          />
          {/* Live checklist — each line lights up green once its rule
              passes, red until then. Helps users see exactly what's
              missing instead of guessing from a single error message. */}
          <ul className="mt-2 text-xs space-y-0.5">
            <RuleRow ok={rules.minLength} label="Не короче 8 символов" />
            <RuleRow ok={rules.hasUpper} label="Хотя бы одна заглавная буква" />
            <RuleRow ok={rules.hasLower} label="Хотя бы одна строчная буква" />
            <RuleRow ok={rules.hasDigit} label="Хотя бы одна цифра" />
          </ul>
        </div>

        {error && <div className="text-red-400 text-sm">{error}</div>}

        <button
          type="submit"
          disabled={loading || !!emailError || !!usernameError || !passwordOk}
          className="w-full bg-accent py-2 rounded font-medium disabled:opacity-50"
        >
          {loading ? "Создаём…" : "Зарегистрироваться"}
        </button>

        <div className="text-sm text-muted text-center">
          Уже есть аккаунт? <Link to="/login" className="text-accent">Войти</Link>
        </div>
      </form>
    </div>
  );
}

interface RuleRowProps {
  ok: boolean;
  label: string;
}
function RuleRow({ ok, label }: RuleRowProps) {
  return (
    <li className={ok ? "text-green-400" : "text-muted"}>
      <span className="inline-block w-4">{ok ? "✓" : "•"}</span>
      {label}
    </li>
  );
}
