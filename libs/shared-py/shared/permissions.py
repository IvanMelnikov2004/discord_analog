"""Channel permission bitflags."""
from enum import IntFlag


class Permission(IntFlag):
    """Bitwise permissions, Discord-style."""

    NONE = 0
    VIEW_CHANNEL = 1 << 0
    SEND_MESSAGES = 1 << 1
    MANAGE_MESSAGES = 1 << 2
    KICK_MEMBERS = 1 << 3
    BAN_MEMBERS = 1 << 4
    MUTE_MEMBERS = 1 << 5
    MANAGE_ROLES = 1 << 6
    MANAGE_CHANNELS = 1 << 7
    CREATE_INVITE = 1 << 8
    CONNECT_VOICE = 1 << 9
    SPEAK_VOICE = 1 << 10
    # Moderate other members inside a voice room: server-mute their microphone
    # (LiveKit refuses publish) and/or kick them out of the LiveKit session.
    # Separate from MUTE_MEMBERS/KICK_MEMBERS which act on the whole channel.
    VOICE_MODERATE = 1 << 11
    # Drag-and-drop / push a member from one voice room to another in the same
    # channel. Implemented as: remove them from the current LiveKit room and
    # tell their client to auto-join the destination. Separate from
    # VOICE_MODERATE because moving is less disruptive than kicking — many
    # mods should have one without the other.
    MOVE_VOICE_MEMBERS = 1 << 12
    ADMINISTRATOR = 1 << 31

    @classmethod
    def default_member(cls) -> int:
        return int(
            cls.VIEW_CHANNEL
            | cls.SEND_MESSAGES
            | cls.CREATE_INVITE
            | cls.CONNECT_VOICE
            | cls.SPEAK_VOICE
        )

    @classmethod
    def admin(cls) -> int:
        return int(cls.ADMINISTRATOR)


def has_permission(user_perms: int, required: Permission) -> bool:
    """Admin overrides everything."""
    if user_perms & Permission.ADMINISTRATOR:
        return True
    return bool(user_perms & required)


# ---------- Role hierarchy ----------
#
# Each role has an integer `position`. A member's "rank" is the highest
# position among their roles. Moderation actions (kick/ban/mute, assigning or
# removing roles) are only allowed against a target whose rank is STRICTLY
# lower than the actor's rank. The channel owner outranks everyone.

# Sentinel rank for the channel owner — higher than any real role position.
OWNER_RANK = 1 << 30


def can_act_on(
    actor_rank: int,
    target_rank: int,
    actor_is_owner: bool = False,
    target_is_owner: bool = False,
) -> bool:
    """Return True if actor may perform a moderation action on target.

    Rules:
      - The owner can act on anyone; nobody can act on the owner.
      - Otherwise the actor must strictly outrank the target.
    """
    if target_is_owner:
        return False
    if actor_is_owner:
        return True
    return actor_rank > target_rank


def can_manage_role(actor_rank: int, role_position: int, actor_is_owner: bool = False) -> bool:
    """Whether the actor may assign/remove/edit a role of the given position.

    You cannot grant or manage a role at or above your own rank (prevents
    privilege escalation). The owner can manage any role.
    """
    if actor_is_owner:
        return True
    return actor_rank > role_position
