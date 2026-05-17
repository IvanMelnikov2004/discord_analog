from app.config import get_settings
from shared.deps import make_current_user_dependency

_s = get_settings()
get_current_user = make_current_user_dependency(_s.JWT_SECRET_KEY, _s.JWT_ALGORITHM)
