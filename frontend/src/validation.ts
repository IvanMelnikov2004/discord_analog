/**
 * Client-side validators for auth forms. The server is still the source of
 * truth — these only catch obvious mistakes early so the user gets feedback
 * before a network round-trip.
 */

/**
 * Email regex: looks for `something@something.tld` with at least one dot in
 * the domain. Intentionally permissive — RFC 5322 is much more complex than
 * what we want to enforce in a UI hint. The auth-service has its own check.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateEmail(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return "Введите email";
  if (!EMAIL_RE.test(trimmed)) return "Некорректный email";
  return null;
}

export interface PasswordRules {
  minLength: boolean;
  hasUpper: boolean;
  hasLower: boolean;
  hasDigit: boolean;
}

/** Per-rule breakdown so the UI can show a live checklist while the user
 * is typing, with each rule turning green as it's satisfied. */
export function checkPasswordRules(value: string): PasswordRules {
  return {
    minLength: value.length >= 8,
    hasUpper: /[A-Z]/.test(value),
    hasLower: /[a-z]/.test(value),
    hasDigit: /\d/.test(value),
  };
}

/** Single combined check — returns the first failing message or null. */
export function validatePassword(value: string): string | null {
  if (!value) return "Введите пароль";
  const r = checkPasswordRules(value);
  if (!r.minLength) return "Пароль должен быть не короче 8 символов";
  if (!r.hasUpper) return "Пароль должен содержать заглавную букву";
  if (!r.hasLower) return "Пароль должен содержать строчную букву";
  if (!r.hasDigit) return "Пароль должен содержать цифру";
  return null;
}
