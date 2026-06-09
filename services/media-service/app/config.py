from functools import lru_cache
from shared.config import BaseAppSettings, RedisMixin


class Settings(BaseAppSettings, RedisMixin):
    SERVICE_NAME: str = "media-service"
    LIVEKIT_API_KEY: str = "devkey"
    LIVEKIT_API_SECRET: str = "devsecret"
    # Public URL handed to BROWSERS: this is what they connect to over wss.
    # Goes through Traefik / load balancer in production.
    LIVEKIT_URL: str = "ws://localhost:7880"
    # INTERNAL host/port that THIS service uses for server-to-server calls to
    # LiveKit Room Service (Twirp /twirp/livekit.RoomService/...). These calls
    # must NOT go through the public ingress because Traefik has no route for
    # /twirp; they need to hit LiveKit's HTTP listener directly in the docker
    # network. With our compose setup that's http://livekit:7880.
    LIVEKIT_HOST: str = "livekit"
    LIVEKIT_PORT: int = 7880
    # Used to check the caller's mute status when minting LiveKit tokens.
    CHANNEL_SERVICE_URL: str = "http://channel-service:8000"

    @property
    def livekit_internal_url(self) -> str:
        return f"http://{self.LIVEKIT_HOST}:{self.LIVEKIT_PORT}"


@lru_cache
def get_settings() -> Settings:
    return Settings()
