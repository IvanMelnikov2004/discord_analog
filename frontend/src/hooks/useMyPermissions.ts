import { useQuery } from "@tanstack/react-query";
import { api } from "../api";

export interface MyPerms {
  channel_id: string;
  permissions: number;
  rank: number;
  is_owner: boolean;
  is_admin: boolean;
  names: string[];
  /** Whether the current user is muted in this channel right now. */
  muted: boolean;
  /** ISO timestamp when a timed mute expires; null for permanent. */
  muted_until: string | null;
}

/**
 * Current user's effective permissions in a channel + a `can(name)` helper.
 * `can` returns true for admins/owners regardless of the specific flag.
 */
export function useMyPermissions(channelId: string | undefined) {
  const query = useQuery<MyPerms>({
    queryKey: ["myPerms", channelId],
    queryFn: async () =>
      (await api.get<MyPerms>(`/channels/${channelId}/me/permissions`)).data,
    enabled: !!channelId,
  });

  const can = (name: string): boolean => {
    const p = query.data;
    if (!p) return false;
    if (p.is_owner || p.is_admin) return true;
    return p.names.includes(name);
  };

  return { perms: query.data, can, isLoading: query.isLoading };
}
