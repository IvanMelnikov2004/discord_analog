/**
 * Shared transient flag set by GlobalEventListener when a voice.moved event
 * arrives, and read by VoiceRoom to decide whether the imminent
 * RoomEvent.Disconnected(PARTICIPANT_REMOVED) was a moderator move (suppress
 * "you were kicked" UI) or a real kick.
 *
 * Uses module-level state instead of context/zustand because both readers
 * and writers live in unrelated components — and the flag is only valid for
 * a couple of seconds.
 */

let expiresAt = 0;

/** Mark "the next disconnect is from a move", valid for ~3 seconds. */
export function markMoveInProgress(): void {
  expiresAt = Date.now() + 3000;
}

/** True if a move is currently in flight (consumes a window of ~3s). */
export function isMoveInProgress(): boolean {
  return Date.now() < expiresAt;
}
