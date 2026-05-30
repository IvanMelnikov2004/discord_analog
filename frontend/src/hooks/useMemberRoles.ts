import { useQuery } from "@tanstack/react-query";
import { api } from "../api";

interface Role {
  id: string;
  name: string;
  color: string | null;
  position: number;
  is_default: boolean;
}

interface Member {
  id: string;
  user_id: string;
  nickname: string | null;
}

export interface UserRoleInfo {
  /** Highest non-default role (for name color + label), or null. */
  topRole: { name: string; color: string | null; position: number } | null;
  nickname: string | null;
}

/**
 * Returns a map userId -> UserRoleInfo for a channel, resolving each member's
 * highest-position non-default role. Used to color names and show role tags
 * in chat. Cached by react-query; refetched when roles/members change.
 */
export function useMemberRoles(channelId: string | undefined) {
  return useQuery<Record<string, UserRoleInfo>>({
    queryKey: ["memberRoleInfo", channelId],
    enabled: !!channelId,
    queryFn: async () => {
      const [rolesRes, membersRes] = await Promise.all([
        api.get<Role[]>(`/channels/${channelId}/roles`),
        api.get<Member[]>(`/channels/${channelId}/members`),
      ]);
      const roles = rolesRes.data;
      const members = membersRes.data;
      const roleById = new Map(roles.map((r) => [r.id, r]));

      const out: Record<string, UserRoleInfo> = {};
      // Fetch each member's role ids and compute their highest-position role.
      await Promise.all(
        members.map(async (m) => {
          let topRole: UserRoleInfo["topRole"] = null;
          try {
            const { data: roleIds } = await api.get<string[]>(
              `/channels/${channelId}/members/${m.id}/roles`
            );
            for (const rid of roleIds) {
              const r = roleById.get(rid);
              if (!r || r.is_default) continue;
              if (!topRole || r.position > topRole.position) {
                topRole = { name: r.name, color: r.color, position: r.position };
              }
            }
          } catch {
            /* ignore */
          }
          out[m.user_id] = { topRole, nickname: m.nickname };
        })
      );
      return out;
    },
  });
}
