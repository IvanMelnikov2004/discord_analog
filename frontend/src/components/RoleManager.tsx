import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import {
  PERMISSIONS,
  PERM_GROUPS,
  hasPerm,
  togglePerm,
} from "../permissions";

interface Role {
  id: string;
  channel_id: string;
  name: string;
  permissions: number;
  color: string | null;
  position: number;
  is_default: boolean;
}

interface Member {
  id: string;
  user_id: string;
  nickname: string | null;
  muted: boolean;
}

interface MyPerms {
  permissions: number;
  rank: number;
  is_owner: boolean;
  is_admin: boolean;
  names: string[];
}

interface Props {
  channelId: string;
  onClose: () => void;
}

type Tab = "roles" | "members";

export default function RoleManager({ channelId, onClose }: Props) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("roles");
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  const [newRoleName, setNewRoleName] = useState("");

  const { data: myPerms } = useQuery({
    queryKey: ["myPerms", channelId],
    queryFn: async () => (await api.get<MyPerms>(`/channels/${channelId}/me/permissions`)).data,
  });

  const { data: roles = [] } = useQuery({
    queryKey: ["roles", channelId],
    queryFn: async () => (await api.get<Role[]>(`/channels/${channelId}/roles`)).data,
  });

  const { data: members = [] } = useQuery({
    queryKey: ["members", channelId],
    queryFn: async () => (await api.get<Member[]>(`/channels/${channelId}/members`)).data,
  });

  const myRank = myPerms?.is_owner ? Number.MAX_SAFE_INTEGER : myPerms?.rank ?? 0;
  const canManage = !!(myPerms?.is_admin || myPerms?.names.includes("MANAGE_ROLES"));

  // ---- mutations ----
  const createRole = useMutation({
    mutationFn: async (name: string) =>
      (await api.post(`/channels/${channelId}/roles`, { name, permissions: 0 })).data,
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["roles", channelId] });
      setNewRoleName("");
      setSelectedRoleId(r.id);
    },
  });

  const updateRole = useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Partial<Role> }) =>
      (await api.patch(`/channels/${channelId}/roles/${id}`, patch)).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["roles", channelId] });
      qc.invalidateQueries({ queryKey: ["memberRoleInfo", channelId] });
    },
  });

  const deleteRole = useMutation({
    mutationFn: async (id: string) => api.delete(`/channels/${channelId}/roles/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["roles", channelId] });
      setSelectedRoleId(null);
    },
  });

  const assignRole = useMutation({
    mutationFn: async ({ memberId, roleId }: { memberId: string; roleId: string }) =>
      api.post(`/channels/${channelId}/members/${memberId}/roles`, { role_id: roleId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["memberRoles", channelId] });
      qc.invalidateQueries({ queryKey: ["memberRoleInfo", channelId] });
    },
  });

  const revokeRole = useMutation({
    mutationFn: async ({ memberId, roleId }: { memberId: string; roleId: string }) =>
      api.delete(`/channels/${channelId}/members/${memberId}/roles/${roleId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["memberRoles", channelId] });
      qc.invalidateQueries({ queryKey: ["memberRoleInfo", channelId] });
    },
  });

  const selectedRole = roles.find((r) => r.id === selectedRoleId) || null;

  // A role is editable only if its position is strictly below my rank
  // (mirrors backend anti-escalation). Owner can edit anything.
  const canEditRole = (role: Role): boolean =>
    !!myPerms?.is_owner || (canManage && role.position < myRank);

  function toggleRolePerm(role: Role, bit: number) {
    const next = togglePerm(role.permissions, bit);
    updateRole.mutate({ id: role.id, patch: { permissions: next } });
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-panel2 rounded-lg w-full max-w-4xl h-[80vh] flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-panel">
          <h2 className="text-lg font-semibold">Управление ролями</h2>
          <button onClick={onClose} className="text-muted hover:text-text text-xl leading-none">
            ✕
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-panel">
          <button
            onClick={() => setTab("roles")}
            className={`px-4 py-2 text-sm ${tab === "roles" ? "border-b-2 border-accent text-text" : "text-muted"}`}
          >
            Роли
          </button>
          <button
            onClick={() => setTab("members")}
            className={`px-4 py-2 text-sm ${tab === "members" ? "border-b-2 border-accent text-text" : "text-muted"}`}
          >
            Участники
          </button>
        </div>

        {!canManage && (
          <div className="p-4 text-sm text-amber-400">
            У вас нет права «Управление ролями» — доступен только просмотр.
          </div>
        )}

        {/* Body */}
        <div className="flex-1 overflow-hidden flex">
          {tab === "roles" ? (
            <>
              {/* Roles list */}
              <div className="w-56 border-r border-panel overflow-y-auto p-2 space-y-1">
                {roles
                  .slice()
                  .sort((a, b) => b.position - a.position)
                  .map((r) => (
                    <button
                      key={r.id}
                      onClick={() => setSelectedRoleId(r.id)}
                      className={`block w-full text-left px-2 py-1 rounded text-sm truncate ${
                        r.id === selectedRoleId ? "bg-panel" : "hover:bg-panel"
                      }`}
                      style={r.color ? { color: r.color } : undefined}
                    >
                      {r.name}
                      {r.is_default && <span className="text-muted text-xs ml-1">(база)</span>}
                    </button>
                  ))}

                {canManage && (
                  <div className="pt-2 mt-2 border-t border-panel space-y-1">
                    <input
                      value={newRoleName}
                      onChange={(e) => setNewRoleName(e.target.value)}
                      placeholder="Новая роль"
                      className="w-full bg-bg p-1 text-sm rounded"
                    />
                    <button
                      onClick={() => newRoleName.trim() && createRole.mutate(newRoleName.trim())}
                      className="w-full bg-accent text-sm py-1 rounded"
                    >
                      + Создать роль
                    </button>
                  </div>
                )}
              </div>

              {/* Role editor */}
              <div className="flex-1 overflow-y-auto p-4">
                {!selectedRole ? (
                  <div className="text-muted text-sm">Выберите роль слева</div>
                ) : (
                  <RoleEditor
                    role={selectedRole}
                    editable={canEditRole(selectedRole)}
                    onRename={(name) =>
                      updateRole.mutate({ id: selectedRole.id, patch: { name } })
                    }
                    onSetColor={(color) =>
                      updateRole.mutate({ id: selectedRole.id, patch: { color } })
                    }
                    onToggle={(bit) => toggleRolePerm(selectedRole, bit)}
                    onDelete={() => deleteRole.mutate(selectedRole.id)}
                  />
                )}
              </div>
            </>
          ) : (
            <MembersTab
              channelId={channelId}
              members={members}
              roles={roles}
              canManage={!!canManage}
              myRank={myRank}
              isOwner={!!myPerms?.is_owner}
              onAssign={(memberId, roleId) => assignRole.mutate({ memberId, roleId })}
              onRevoke={(memberId, roleId) => revokeRole.mutate({ memberId, roleId })}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- Role editor (permissions checkboxes) ----------

// A small curated palette (Discord-like) plus a free custom picker.
const ROLE_COLORS = [
  "#5865f2", "#3ba55d", "#faa61a", "#ed4245", "#eb459e",
  "#9b59b6", "#1abc9c", "#e67e22", "#71368a", "#206694",
  "#11806a", "#c27c0e", "#992d22", "#979c9f",
];

function RoleEditor({
  role,
  editable,
  onRename,
  onSetColor,
  onToggle,
  onDelete,
}: {
  role: Role;
  editable: boolean;
  onRename: (name: string) => void;
  onSetColor: (color: string) => void;
  onToggle: (bit: number) => void;
  onDelete: () => void;
}) {
  const [name, setName] = useState(role.name);
  const isAdmin = hasPerm(role.permissions, 2147483648);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        {/* Color swatch reflecting the role's current color */}
        <span
          className="w-5 h-5 rounded-full border border-panel2 shrink-0"
          style={{ backgroundColor: role.color || "#979c9f" }}
          title={role.color || "нет цвета"}
        />
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name !== role.name && editable && !role.is_default && onRename(name)}
          disabled={!editable || role.is_default}
          className="bg-bg p-2 rounded flex-1 disabled:opacity-60"
          style={role.color ? { color: role.color } : undefined}
        />
        {!role.is_default && editable && (
          <button
            onClick={onDelete}
            className="bg-red-600/80 hover:bg-red-600 text-sm px-3 py-2 rounded"
          >
            Удалить
          </button>
        )}
      </div>

      {/* Color picker */}
      {editable && (
        <div>
          <div className="text-xs uppercase text-muted mb-1">Цвет роли</div>
          <div className="flex flex-wrap items-center gap-2">
            {ROLE_COLORS.map((c) => (
              <button
                key={c}
                onClick={() => onSetColor(c)}
                className={`w-6 h-6 rounded-full border-2 ${
                  role.color?.toLowerCase() === c ? "border-white" : "border-transparent"
                }`}
                style={{ backgroundColor: c }}
                title={c}
              />
            ))}
            {/* Free custom color */}
            <label className="w-6 h-6 rounded-full border border-panel2 overflow-hidden cursor-pointer flex items-center justify-center text-xs">
              <input
                type="color"
                value={role.color || "#5865f2"}
                onChange={(e) => onSetColor(e.target.value)}
                className="w-8 h-8 cursor-pointer opacity-0 absolute"
              />
              🎨
            </label>
          </div>
        </div>
      )}

      {!editable && (
        <div className="text-xs text-amber-400">
          Эту роль нельзя редактировать: её позиция не ниже вашей.
        </div>
      )}

      {PERM_GROUPS.map((group) => {
        const perms = PERMISSIONS.filter((p) => p.group === group);
        if (perms.length === 0) return null;
        return (
          <div key={group}>
            <div className="text-xs uppercase text-muted mb-1">{group}</div>
            <div className="space-y-1">
              {perms.map((p) => {
                const checked = (role.permissions & p.bit) === p.bit;
                // If ADMINISTRATOR is on, everything is implicitly granted.
                const implied = isAdmin && p.key !== "ADMINISTRATOR";
                return (
                  <label
                    key={p.key}
                    className={`flex items-center gap-2 text-sm ${
                      editable ? "cursor-pointer" : "opacity-60"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked || implied}
                      disabled={!editable || implied}
                      onChange={() => onToggle(p.bit)}
                    />
                    <span>{p.label}</span>
                    {implied && <span className="text-muted text-xs">(через админа)</span>}
                  </label>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------- Members tab ----------

function MembersTab({
  channelId,
  members,
  roles,
  canManage,
  myRank,
  isOwner,
  onAssign,
  onRevoke,
}: {
  channelId: string;
  members: Member[];
  roles: Role[];
  canManage: boolean;
  myRank: number;
  isOwner: boolean;
  onAssign: (memberId: string, roleId: string) => void;
  onRevoke: (memberId: string, roleId: string) => void;
}) {
  const qc = useQueryClient();

  // Fetch each member's role ids. We piggyback on a single query that maps
  // memberId -> roleIds by reading the member roles endpoint per member.
  // The backend has no bulk endpoint, so we derive from roles+members via a
  // lightweight per-member fetch cached together.
  const { data: memberRoles = {} } = useQuery<Record<string, string[]>>({
    queryKey: ["memberRoles", channelId, members.map((m) => m.id).join(",")],
    enabled: members.length > 0,
    queryFn: async () => {
      // There's no GET for a member's roles in the MVP API, so we infer by
      // attempting assignment idempotently is wrong; instead we read from a
      // dedicated endpoint if present. Fallback: empty (assignments still work).
      const out: Record<string, string[]> = {};
      for (const m of members) {
        try {
          const { data } = await api.get<string[]>(
            `/channels/${channelId}/members/${m.id}/roles`
          );
          out[m.id] = data;
        } catch {
          out[m.id] = [];
        }
      }
      return out;
    },
  });

  const canManageRole = (role: Role) => isOwner || (canManage && role.position < myRank);

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-3">
      {members.map((m) => {
        const assigned = memberRoles[m.id] || [];
        return (
          <div key={m.id} className="bg-panel rounded p-3">
            <div className="text-sm font-medium mb-2">
              {m.nickname || m.user_id.slice(0, 8)}
              {m.muted && <span className="text-muted text-xs ml-1">(muted)</span>}
            </div>
            <div className="flex flex-wrap gap-2">
              {roles
                .filter((r) => !r.is_default)
                .map((r) => {
                  const has = assigned.includes(r.id);
                  const manageable = canManageRole(r);
                  return (
                    <button
                      key={r.id}
                      disabled={!manageable}
                      onClick={() =>
                        has ? onRevoke(m.id, r.id) : onAssign(m.id, r.id)
                      }
                      className={`text-xs px-2 py-1 rounded border ${
                        has
                          ? "bg-accent border-accent"
                          : "bg-bg border-panel2 text-muted"
                      } ${manageable ? "" : "opacity-50 cursor-not-allowed"}`}
                      style={r.color && has ? { backgroundColor: r.color } : undefined}
                    >
                      {has ? "✓ " : "+ "}
                      {r.name}
                    </button>
                  );
                })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
