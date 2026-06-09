import { useEffect, useRef, useState } from "react";
import {
  Room,
  RoomEvent,
  RemoteParticipant,
  RemoteTrack,
  RemoteTrackPublication,
  Track,
  DisconnectReason,
} from "livekit-client";
import { api } from "../api";
import { useAuthStore } from "../store/auth";
import { useMyPermissions } from "../hooks/useMyPermissions";
import { useMemberRoles } from "../hooks/useMemberRoles";

interface Props {
  roomId: string;
  channelId: string;
}

interface ParticipantView {
  identity: string;
  isLocal: boolean;
  speaking: boolean;
  /** True when the participant's microphone is muted (server- or self-).
   *  We can't distinguish moderator-mute from self-mute on the client —
   *  LiveKit only exposes "track muted". For our UI that's fine: the
   *  toggle works the same way and the server enforces VOICE_MODERATE. */
  micMuted: boolean;
}

/**
 * Per-participant audio element registry. We attach LiveKit RemoteTracks
 * to <audio> elements, then route them through Web Audio API so we can
 * apply a per-user gain (volume slider). The map is keyed by identity.
 */
type AudioContextEntry = {
  audioEl: HTMLAudioElement;
  source: MediaStreamAudioSourceNode;
  gain: GainNode;
};

function localVolumeKey(identity: string): string {
  // Persist per-user volume in localStorage so it survives reloads.
  return `voice-volume:${identity}`;
}

function loadLocalVolume(identity: string): number {
  const raw = localStorage.getItem(localVolumeKey(identity));
  if (raw === null) return 1.0;
  const v = parseFloat(raw);
  return Number.isFinite(v) ? Math.max(0, Math.min(2, v)) : 1.0;
}

function saveLocalVolume(identity: string, value: number): void {
  localStorage.setItem(localVolumeKey(identity), String(value));
}

export default function VoiceRoom({ roomId, channelId }: Props) {
  const userId = useAuthStore((s) => s.userId)!;
  const { can } = useMyPermissions(channelId);
  const { data: roleInfo = {} } = useMemberRoles(channelId);
  const canModerateVoice = can("VOICE_MODERATE");

  const [room, setRoom] = useState<Room | null>(null);
  const [connected, setConnected] = useState(false);
  const [muted, setMuted] = useState(false);
  const [canPublish, setCanPublish] = useState(true);
  const [participants, setParticipants] = useState<ParticipantView[]>([]);
  const [error, setError] = useState("");
  const [kickedNotice, setKickedNotice] = useState("");

  // Per-identity volume (0..2). 1.0 = normal, 0 = local mute, 2 = +200%.
  // Initial values are read lazily from localStorage when a participant is
  // first added so we restore each user's preferred level.
  const [volumes, setVolumes] = useState<Record<string, number>>({});

  // Audio nodes by identity (so we can apply gain changes when slider moves).
  const audioCtxRef = useRef<AudioContext | null>(null);
  const audioMap = useRef<Map<string, AudioContextEntry>>(new Map());

  function ensureAudioContext(): AudioContext {
    if (!audioCtxRef.current) {
      const Ctx = window.AudioContext || (window as any).webkitAudioContext;
      audioCtxRef.current = new Ctx();
    }
    return audioCtxRef.current;
  }

  function attachRemoteAudio(track: RemoteTrack, identity: string) {
    // Build a <audio> element from the track but mute its DOM playback —
    // we'll play it through the Web Audio graph instead so we can apply a
    // per-user GainNode (volume slider).
    const audioEl = track.attach() as HTMLAudioElement;
    audioEl.id = `audio-${identity}`;
    audioEl.muted = true;
    audioEl.autoplay = true;
    document.body.appendChild(audioEl);

    const ctx = ensureAudioContext();
    if (ctx.state === "suspended") {
      // Autoplay policy: resume on the first user gesture (Join click already
      // counts), but be defensive.
      void ctx.resume();
    }

    // Use the MediaStream from the audio element. Going via createMediaStreamSource
    // requires a MediaStream object, which is what LiveKit's track exposes.
    const stream = (track as any).mediaStream as MediaStream | undefined;
    if (!stream) {
      // Fallback: keep the <audio> unmuted and rely on its native playback
      // (no per-user volume in this case, but at least we hear them).
      audioEl.muted = false;
      return;
    }
    const source = ctx.createMediaStreamSource(stream);
    const gain = ctx.createGain();
    gain.gain.value = loadLocalVolume(identity);
    source.connect(gain).connect(ctx.destination);

    audioMap.current.set(identity, { audioEl, source, gain });
    setVolumes((v) => ({ ...v, [identity]: gain.gain.value }));
  }

  function detachRemoteAudio(identity: string) {
    const entry = audioMap.current.get(identity);
    if (!entry) return;
    try {
      entry.source.disconnect();
      entry.gain.disconnect();
    } catch {}
    entry.audioEl.remove();
    audioMap.current.delete(identity);
  }

  function setParticipantVolume(identity: string, value: number) {
    const entry = audioMap.current.get(identity);
    if (entry) entry.gain.gain.value = value;
    setVolumes((v) => ({ ...v, [identity]: value }));
    saveLocalVolume(identity, value);
  }

  async function join() {
    setError("");
    setKickedNotice("");
    try {
      const { data } = await api.post("/media/token", {
        room_id: roomId,
        channel_id: channelId,
      });
      const allowedToPublish = data.can_publish !== false;
      setCanPublish(allowedToPublish);

      const r = new Room({ adaptiveStream: true, dynacast: true });

      r.on(RoomEvent.TrackSubscribed, (
        track: RemoteTrack,
        _pub: RemoteTrackPublication,
        p: RemoteParticipant
      ) => {
        if (track.kind === Track.Kind.Audio) attachRemoteAudio(track, p.identity);
      });

      r.on(RoomEvent.TrackUnsubscribed, (
        _track: RemoteTrack,
        _pub: RemoteTrackPublication,
        p: RemoteParticipant
      ) => {
        detachRemoteAudio(p.identity);
      });

      r.on(RoomEvent.ParticipantConnected, () => updateParticipants(r));
      r.on(RoomEvent.ParticipantDisconnected, (p) => {
        detachRemoteAudio(p.identity);
        updateParticipants(r);
      });
      r.on(RoomEvent.ActiveSpeakersChanged, () => updateParticipants(r));
      // When any participant's microphone is muted/unmuted (either by self
      // or by a moderator via mute_published_track), refresh the view so
      // the mic icon next to their name updates instantly.
      r.on(RoomEvent.TrackMuted, () => updateParticipants(r));
      r.on(RoomEvent.TrackUnmuted, () => updateParticipants(r));

      // When a moderator kicks us, LiveKit fires Disconnected with a reason.
      r.on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
        if (
          reason === DisconnectReason.PARTICIPANT_REMOVED ||
          reason === DisconnectReason.ROOM_DELETED
        ) {
          setKickedNotice("Вас выгнали из голосового канала");
        }
        cleanup();
      });

      await r.connect(data.url, data.token);
      if (allowedToPublish) {
        await r.localParticipant.setMicrophoneEnabled(true);
      } else {
        setMuted(true);
      }

      setRoom(r);
      setConnected(true);
      updateParticipants(r);
    } catch (e: any) {
      setError(e?.message || "Не удалось зайти в голосовой канал");
    }
  }

  function updateParticipants(r: Room) {
    const speakingSet = new Set(r.activeSpeakers.map((p) => p.identity));
    // For local: LiveKit tracks the user's own mic via isMicrophoneEnabled().
    // For remote: the audio publication (Track.Source.Microphone) exposes
    // `.isMuted`. If there's no audio publication yet (they haven't unmuted
    // ever), treat as muted — they can't be heard anyway.
    const me: ParticipantView = {
      identity: r.localParticipant.identity,
      isLocal: true,
      speaking: speakingSet.has(r.localParticipant.identity),
      micMuted: !r.localParticipant.isMicrophoneEnabled,
    };
    const others: ParticipantView[] = Array.from(r.remoteParticipants.values()).map(
      (p) => {
        const micPub = p.getTrackPublication(Track.Source.Microphone);
        return {
          identity: p.identity,
          isLocal: false,
          speaking: speakingSet.has(p.identity),
          micMuted: !micPub || micPub.isMuted,
        };
      }
    );
    setParticipants([me, ...others]);
  }

  function cleanup() {
    audioMap.current.forEach((_, id) => detachRemoteAudio(id));
    audioMap.current.clear();
    setRoom(null);
    setConnected(false);
    setParticipants([]);
  }

  async function leave() {
    if (room) {
      await room.disconnect();
    }
    cleanup();
  }

  async function toggleMicrophone() {
    if (!room || !canPublish) return;
    const next = !muted;
    await room.localParticipant.setMicrophoneEnabled(!next);
    setMuted(next);
  }

  // ---------- Moderator actions ----------

  async function modVoiceMute(targetIdentity: string, mute: boolean) {
    try {
      await api.post(`/media/rooms/${roomId}/voice-mute`, {
        channel_id: channelId,
        target_identity: targetIdentity,
        muted: mute,
      });
    } catch (e: any) {
      setError(e?.response?.data?.detail || "Не удалось замьютить");
    }
  }

  async function modVoiceKick(targetIdentity: string) {
    if (!confirm("Выгнать этого участника из голосового канала?")) return;
    try {
      await api.post(`/media/rooms/${roomId}/voice-kick`, {
        channel_id: channelId,
        target_identity: targetIdentity,
      });
    } catch (e: any) {
      setError(e?.response?.data?.detail || "Не удалось выгнать");
    }
  }

  // Helpful labels: prefer nickname/top role color from member roles cache.
  function labelFor(identity: string): { text: string; color?: string } {
    const info = roleInfo[identity];
    const nick = info?.nickname || identity.slice(0, 8);
    return { text: nick, color: info?.topRole?.color || undefined };
  }

  useEffect(
    () => () => {
      // Cleanup on unmount: disconnect, detach all audio.
      room?.disconnect();
      audioMap.current.forEach((_, id) => detachRemoteAudio(id));
      audioMap.current.clear();
      audioCtxRef.current?.close().catch(() => {});
    },
    [room]
  );

  return (
    <div className="p-4 bg-panel rounded space-y-3">
      <h3 className="font-medium">Голосовая комната</h3>
      {error && <div className="text-red-400 text-sm">{error}</div>}
      {kickedNotice && (
        <div className="text-amber-400 text-sm">{kickedNotice}</div>
      )}

      {!connected ? (
        <button onClick={join} className="bg-accent px-4 py-2 rounded">
          Зайти в голос
        </button>
      ) : (
        <>
          {!canPublish && (
            <div className="text-xs text-amber-400 bg-amber-400/10 rounded px-2 py-1">
              🔇 Вы замьючены модератором — слышите других, но микрофон отключён
            </div>
          )}

          <div className="space-y-2">
            {participants.map((p) => {
              const lab = labelFor(p.identity);
              const vol = volumes[p.identity] ?? 1.0;
              const isLocallyMuted = !p.isLocal && vol === 0;
              return (
                <div
                  key={p.identity}
                  className={`px-2 py-2 rounded ${
                    p.speaking ? "bg-green-600/30" : "bg-panel2"
                  }`}
                >
                  <div className="flex items-center gap-2 text-sm">
                    <span style={lab.color ? { color: lab.color } : undefined}>
                      {lab.text}
                      {p.isLocal && (
                        <span className="text-muted text-xs"> (вы)</span>
                      )}
                    </span>
                    {!p.isLocal && canModerateVoice && (
                      <span className="ml-auto flex gap-1">
                        <button
                          onClick={() => modVoiceMute(p.identity, !p.micMuted)}
                          className="text-xs bg-bg hover:bg-panel px-2 py-0.5 rounded"
                          title={
                            p.micMuted
                              ? "Снять серверный мьют"
                              : "Серверный мьют: запретить микрофон"
                          }
                        >
                          {p.micMuted ? "🔊 unmute" : "🔇 mute"}
                        </button>
                        <button
                          onClick={() => modVoiceKick(p.identity)}
                          className="text-xs bg-red-600/70 hover:bg-red-600 px-2 py-0.5 rounded"
                          title="Выгнать из голоса"
                        >
                          ✕ kick
                        </button>
                      </span>
                    )}
                  </div>

                  {/* Per-user local volume — only meaningful for remote
                      participants (you can't change the gain on your own
                      microphone here). */}
                  {!p.isLocal && (
                    <div className="flex items-center gap-2 mt-1">
                      <button
                        onClick={() =>
                          setParticipantVolume(p.identity, isLocallyMuted ? 1.0 : 0)
                        }
                        className="text-xs w-6 text-center"
                        title={isLocallyMuted ? "Включить" : "Локально замьютить"}
                      >
                        {isLocallyMuted ? "🔇" : "🔈"}
                      </button>
                      <input
                        type="range"
                        min={0}
                        max={2}
                        step={0.05}
                        value={vol}
                        onChange={(e) =>
                          setParticipantVolume(p.identity, parseFloat(e.target.value))
                        }
                        className="flex-1 accent-accent"
                      />
                      <span className="text-xs text-muted w-10 text-right">
                        {Math.round(vol * 100)}%
                      </span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="flex gap-2">
            <button
              onClick={toggleMicrophone}
              disabled={!canPublish}
              className="bg-panel2 px-3 py-1 rounded text-sm disabled:opacity-50 disabled:cursor-not-allowed"
              title={!canPublish ? "Микрофон запрещён модератором" : ""}
            >
              {muted ? "🎙 Включить микрофон" : "🔕 Выключить микрофон"}
            </button>
            <button onClick={leave} className="bg-red-600 px-3 py-1 rounded text-sm">
              Выйти
            </button>
          </div>
        </>
      )}
    </div>
  );
}
