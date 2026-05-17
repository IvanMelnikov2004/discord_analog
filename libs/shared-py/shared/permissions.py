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
