# Messenger — MVP

E2EE-мессенджер с групповыми чатами, каналами (Discord-like), голосовыми звонками через LiveKit.

## Стек

- **Backend**: Python 3.11, FastAPI, SQLAlchemy 2.0 (async), Motor (MongoDB), Redis
- **Frontend**: React 18 + TypeScript + Vite + TailwindCSS
- **Realtime**: WebSocket (FastAPI), Redis Pub/Sub
- **Voice**: LiveKit (self-hosted)
- **Шифрование**: Web Crypto API на клиенте — AES-256-GCM, ECDH P-256, ECDSA; Sender Keys для групп
- **Инфра**: Docker Compose, Traefik

## Быстрый старт

```bash
# 1. Скопировать env
cp .env.example .env
# (отредактировать секреты в .env — особенно JWT_SECRET_KEY и LIVEKIT_API_SECRET)

# 2. Поднять всё
make up

# 3. Применить миграции
make migrate

# 4. Открыть в браузере
# Frontend:        http://localhost
# Traefik dash:    http://localhost:8080
```

## Структура

```
services/
├── auth-service/      — регистрация, JWT, публичные ключи
├── user-service/      — профили, друзья
├── channel-service/   — каналы, комнаты, роли, инвайты
├── message-service/   — хранение зашифрованных сообщений (MongoDB)
├── gateway-service/   — WebSocket gateway
└── media-service/     — LiveKit access tokens

frontend/              — React + Vite SPA
libs/shared-py/        — общие модули (config, JWT, logging)
infrastructure/        — конфиги Traefik, LiveKit, init.sql для Postgres
```

## Архитектурные заметки

### E2EE и хранение ключей

- Приватные ключи генерируются на клиенте через Web Crypto API с `extractable: false` и хранятся в IndexedDB.
- На сервер отправляется только публичная часть (через `/api/auth/keys`).
- Сообщения шифруются на клиенте AES-256-GCM. Сервер хранит и пересылает только шифротекст.
- Для групповых чатов — модель **Sender Keys**: каждый участник генерирует свой sender key, рассылает его остальным через pairwise ECDH-secure канал.

### Пермиссии каналов

Битовые маски (bigint):
```
VIEW_CHANNEL       = 1 << 0
SEND_MESSAGES      = 1 << 1
MANAGE_MESSAGES    = 1 << 2
KICK_MEMBERS       = 1 << 3
BAN_MEMBERS        = 1 << 4
MUTE_MEMBERS       = 1 << 5
MANAGE_ROLES       = 1 << 6
MANAGE_CHANNELS    = 1 << 7
CREATE_INVITE      = 1 << 8
CONNECT_VOICE      = 1 << 9
SPEAK_VOICE        = 1 << 10
ADMINISTRATOR      = 1 << 31
```

Эффективные пермиссии = `OR` всех ролей участника + per-room overrides.

### Иерархия ролей (защита от эскалации)

У каждой роли есть `position`. Ранг участника = максимальная позиция среди его
ролей; владелец канала имеет высший ранг (`OWNER_RANK`) независимо от ролей.

Правила (в `shared/permissions.py`: `can_act_on`, `can_manage_role`):
- Модерация (kick/ban/mute) разрешена только против цели со **строго меньшим**
  рангом. Владельца тронуть нельзя; владелец может действовать на любого.
- Нельзя выдать/снять роль с позицией ≥ собственного ранга (анти-эскалация).
- Владелец защищён от самобана и от снятия прав.

Эндпоинт `GET /api/channels/{id}/me/permissions` возвращает эффективные права
текущего пользователя (битмаска + список имён + флаги owner/admin) — фронт по
нему решает, какие элементы управления показывать.

## Деплой на сервер (HTTPS обязателен!)

**Важно:** Web Crypto API (шифрование) и `getUserMedia` (звонки) работают
**только в secure context** — `https://` или `http://localhost`. По `http://<IP>`
регистрация падает с "Registration failed", чат пишет "нет ключа отправителя",
войс — "getUserMedia undefined". Это ограничение браузера, не баг приложения.

### Вариант A — nip.io + Let's Encrypt (РЕКОМЕНДУЕТСЯ для сервера без домена)

`nip.io` — бесплатный DNS: `94-103-13-192.nip.io` автоматически резолвится в
`94.103.13.192`, без регистрации. Это настоящее доменное имя, поэтому
Let's Encrypt выдаст на него **доверенный** сертификат — без предупреждений
браузера, WSS и звонки работают сразу.

Требования: порты **80 и 443 открыты** из интернета (80 нужен для ACME-проверки).

```bash
# 1. В .env прописать домен и почту:
#    DOMAIN=94-103-13-192.nip.io          (свой IP через дефисы)
#    ACME_EMAIL=you@example.com           (реальная почта)
#    VITE_API_BASE_URL=https://94-103-13-192.nip.io/api
#    VITE_WS_URL=wss://94-103-13-192.nip.io/ws
#    VITE_LIVEKIT_URL=wss://94-103-13-192.nip.io
#    CORS_ORIGINS=...,https://94-103-13-192.nip.io

# 2. Пересобрать фронт (VITE_* вшиваются при сборке!) и поднять с prod-оверрайдом
docker compose build frontend
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d

# 3. Открыть https://94-103-13-192.nip.io
#    Первый запрос может занять 10-30с пока Traefik получает сертификат.
```

### Вариант B — self-signed (если порт 80 закрыт / нет доступа извне)

```bash
cd infrastructure/traefik
./gen-cert.sh 94.103.13.192
cd ../..

# В .env: VITE_* на https://94.103.13.192/... (как в варианте A, но с IP)
docker compose build frontend
docker compose up -d              # БЕЗ prod-оверрайда

# Открыть https://94.103.13.192 -> браузер ругнётся на сертификат ->
# "Дополнительно" -> "Перейти". ВАЖНО: Chrome может блокировать WSS к
# self-signed. Если чат/звонки не подключаются — используй вариант A.
```

### Звонки через интернет — порты firewall

LiveKit раздаёт медиа напрямую по UDP/TCP, минуя Traefik. На firewall сервера
открой для входящих:
- **7881/tcp** и **7882/udp** — медиапотоки LiveKit
- **443/tcp**, **80/tcp** — веб + сигналинг

`livekit.yaml` уже выставлен с `use_external_ip: true` — сервер сам определит
свой публичный IP через STUN. Если медиа не идёт, в `livekit.yaml` раскомментируй
`node_ip: 94.103.13.192` с явным IP.

## Что НЕ входит в MVP (на будущее)
- [ ] Поиск по сообщениям (blind index)
- [ ] OAuth (Google/GitHub)
- [ ] Метрики Prometheus + Grafana
- [ ] Аватары через MinIO
- [ ] Запись звонков
- [ ] Демонстрация экрана
- [ ] Push-уведомления
- [ ] E2E-тесты Playwright
- [ ] TURN-сервер для строгих NAT
- [ ] Rate limiting

## Разработка

Каждый сервис можно запускать локально (без Docker):
```bash
cd services/auth-service
pip install -e .
uvicorn app.main:app --reload --port 8001
```
