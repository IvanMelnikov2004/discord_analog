from app.config import get_settings
from shared.deps import make_current_user_dependency

_settings = get_settings()

get_current_user = make_current_user_dependency(
    secret_key=_settings.JWT_SECRET_KEY,
    algorithm=_settings.JWT_ALGORITHM,
)
