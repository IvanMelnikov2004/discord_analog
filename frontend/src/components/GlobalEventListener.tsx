import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useWebSocket } from "../hooks/useWebSocket";
import { useAuthStore } from "../store/auth";

/**
 * Mounted once at app root. Listens for events on the user's personal channel
 * (gateway auto-subscribes us to `user:<myId>` on connect) and reacts:
 *
 *  - user.muted / user.unmuted  -> refresh /me/permissions so the chat input
 *                                  becomes disabled/enabled without a reload.
 *  - user.role_assigned / .role_revoked -> refresh perms + member role info
 *                                  so colors/tags/buttons update live.
 *  - user.kicked / user.banned  -> show a toast and redirect to /.
 *  - user.channel_deleted       -> ditto.
 */
export default function GlobalEventListener() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const userId = useAuthStore((s) => s.userId);
  const accessToken = useAuthStore((s) => s.accessToken);

  const onMessage = (ev: any) => {
    if (!ev || typeof ev.type !== "string") return;
    const channelId: string | undefined = ev.data?.channel_id;

    switch (ev.type) {
      case "user.muted":
      case "user.unmuted":
        if (channelId) {
          qc.invalidateQueries({ queryKey: ["myPerms", channelId] });
        }
        break;

      case "user.role_assigned":
      case "user.role_revoked":
        if (channelId) {
          qc.invalidateQueries({ queryKey: ["myPerms", channelId] });
          qc.invalidateQueries({ queryKey: ["memberRoleInfo", channelId] });
          qc.invalidateQueries({ queryKey: ["memberRoles", channelId] });
        }
        break;

      case "user.kicked":
        alert("Вас исключили из канала.");
        navigate("/");
        break;

      case "user.banned":
        alert(
          ev.data?.reason
            ? `Вас забанили в канале. Причина: ${ev.data.reason}`
            : "Вас забанили в канале."
        );
        navigate("/");
        break;

      case "user.channel_deleted":
        alert("Канал был удалён.");
        navigate("/");
        break;
    }
  };

  // Maintain a single global WS connection that auto-subscribes server-side to
  // `user:<myId>`. We don't need to call subscribe() manually for that channel.
  useWebSocket(onMessage);

  // The hook handles connect/reconnect on accessToken change; nothing to render.
  useEffect(() => {
    // Touch deps so React treats them as relevant; the WebSocket lives in the
    // hook above and reconnects when accessToken or userId changes.
  }, [accessToken, userId]);

  return null;
}
