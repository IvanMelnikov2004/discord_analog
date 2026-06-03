/**
 * Permission bitflags — must mirror libs/shared-py/shared/permissions.py.
 * Used by the role-management UI to render checkboxes and compute bitmasks.
 */

export interface PermDef {
  bit: number;
  key: string;
  label: string;
  group: string;
}

// 1 << n positions, identical to the backend.
export const PERMISSIONS: PermDef[] = [
  { bit: 1 << 0, key: "VIEW_CHANNEL", label: "Просмотр канала", group: "Базовые" },
  { bit: 1 << 1, key: "SEND_MESSAGES", label: "Отправка сообщений", group: "Сообщения" },
  { bit: 1 << 2, key: "MANAGE_MESSAGES", label: "Управление сообщениями", group: "Сообщения" },
  { bit: 1 << 3, key: "KICK_MEMBERS", label: "Исключать участников", group: "Модерация" },
  { bit: 1 << 4, key: "BAN_MEMBERS", label: "Банить участников", group: "Модерация" },
  { bit: 1 << 5, key: "MUTE_MEMBERS", label: "Мьютить участников", group: "Модерация" },
  { bit: 1 << 6, key: "MANAGE_ROLES", label: "Управление ролями", group: "Управление" },
  { bit: 1 << 7, key: "MANAGE_CHANNELS", label: "Управление комнатами", group: "Управление" },
  { bit: 1 << 8, key: "CREATE_INVITE", label: "Создавать приглашения", group: "Приглашения" },
  { bit: 1 << 9, key: "CONNECT_VOICE", label: "Подключение к голосу", group: "Голос" },
  { bit: 1 << 10, key: "SPEAK_VOICE", label: "Говорить в голосе", group: "Голос" },
  { bit: 1 << 11, key: "VOICE_MODERATE", label: "Модерация голоса (мьют/кик)", group: "Голос" },
  // ADMINISTRATOR is 1 << 31. In JS, (1 << 31) is negative due to 32-bit
  // signed shifts, so use a numeric literal instead.
  { bit: 2147483648, key: "ADMINISTRATOR", label: "Администратор (все права)", group: "Особые" },
];

export const PERM_GROUPS = [
  "Базовые",
  "Сообщения",
  "Модерация",
  "Управление",
  "Приглашения",
  "Голос",
  "Особые",
];

/** Whether a bitmask grants a given permission bit (admin overrides all). */
export function hasPerm(mask: number, bit: number): boolean {
  const ADMIN = 2147483648;
  if ((mask & ADMIN) === ADMIN) return true;
  return (mask & bit) === bit;
}

/** Toggle a single bit in a mask, returning the new mask. */
export function togglePerm(mask: number, bit: number): number {
  // Use >>> 0 to keep the result an unsigned 32-bit integer.
  return (mask ^ bit) >>> 0;
}
