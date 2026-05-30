import { useEffect, useState } from "react";
import {
  Room,
  RoomEvent,
  RemoteParticipant,
  RemoteTrack,
  RemoteTrackPublication,
  Track,
} from "livekit-client";
import { api } from "../api";

interface Props {
  roomId: string;
  channelId: string;
}

interface Participant {
  identity: string;
  speaking: boolean;
}

export default function VoiceRoom({ roomId, channelId }: Props) {
  const [room, setRoom] = useState<Room | null>(null);
  const [connected, setConnected] = useState(false);
  const [muted, setMuted] = useState(false);
  const [canPublish, setCanPublish] = useState(true);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [error, setError] = useState("");

  async function join() {
    setError("");
    try {
      // channel_id lets the server check our mute status and decide whether to
      // issue a publish-capable token.
      const { data } = await api.post("/media/token", {
        room_id: roomId,
        channel_id: channelId,
      });
      const allowedToPublish = data.can_publish !== false;
      setCanPublish(allowedToPublish);

      const r = new Room({ adaptiveStream: true, dynacast: true });

      r.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub: RemoteTrackPublication, p: RemoteParticipant) => {
        if (track.kind === Track.Kind.Audio) {
          const el = track.attach();
          el.id = `audio-${p.identity}`;
          document.body.appendChild(el);
        }
      });

      r.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
        track.detach().forEach((el) => el.remove());
      });

      r.on(RoomEvent.ParticipantConnected, () => updateParticipants(r));
      r.on(RoomEvent.ParticipantDisconnected, () => updateParticipants(r));
      r.on(RoomEvent.ActiveSpeakersChanged, () => updateParticipants(r));

      await r.connect(data.url, data.token);
      // If muted, the token has can_publish=false — skip mic init to avoid an
      // error from LiveKit when the user has no publish grant.
      if (allowedToPublish) {
        await r.localParticipant.setMicrophoneEnabled(true);
      } else {
        setMuted(true);
      }

      setRoom(r);
      setConnected(true);
      updateParticipants(r);
    } catch (e: any) {
      setError(e?.message || "Failed to join voice");
    }
  }

  function updateParticipants(r: Room) {
    const speaking = new Set(r.activeSpeakers.map((p) => p.identity));
    const list: Participant[] = [
      { identity: `${r.localParticipant.identity} (you)`, speaking: speaking.has(r.localParticipant.identity) },
      ...Array.from(r.remoteParticipants.values()).map((p) => ({
        identity: p.identity,
        speaking: speaking.has(p.identity),
      })),
    ];
    setParticipants(list);
  }

  async function leave() {
    if (room) {
      await room.disconnect();
      document.querySelectorAll("audio[id^='audio-']").forEach((el) => el.remove());
    }
    setRoom(null);
    setConnected(false);
    setParticipants([]);
  }

  async function toggleMute() {
    if (!room) return;
    const next = !muted;
    await room.localParticipant.setMicrophoneEnabled(!next);
    setMuted(next);
  }

  useEffect(() => () => {
    room?.disconnect();
  }, [room]);

  return (
    <div className="p-4 bg-panel rounded space-y-3">
      <h3 className="font-medium">Voice room</h3>
      {error && <div className="text-red-400 text-sm">{error}</div>}

      {!connected ? (
        <button onClick={join} className="bg-accent px-4 py-2 rounded">
          Join voice
        </button>
      ) : (
        <>
          {!canPublish && (
            <div className="text-xs text-amber-400 bg-amber-400/10 rounded px-2 py-1">
              🔇 Вы замьючены модератором — слышите других, но микрофон отключён
            </div>
          )}
          <div className="space-y-1">
            {participants.map((p) => (
              <div
                key={p.identity}
                className={`text-sm px-2 py-1 rounded ${p.speaking ? "bg-green-600/30" : "bg-panel2"}`}
              >
                {p.identity}
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <button
              onClick={toggleMute}
              disabled={!canPublish}
              className="bg-panel2 px-3 py-1 rounded text-sm disabled:opacity-50 disabled:cursor-not-allowed"
              title={!canPublish ? "Микрофон запрещён модератором" : ""}
            >
              {muted ? "Unmute" : "Mute"}
            </button>
            <button onClick={leave} className="bg-red-600 px-3 py-1 rounded text-sm">
              Leave
            </button>
          </div>
        </>
      )}
    </div>
  );
}
