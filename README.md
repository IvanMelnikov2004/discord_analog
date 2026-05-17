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

## Что НЕ входит в MVP (на будущее)

- [ ] Поиск по сообщениям (blind index)
- [ ] OAuth (Google/GitHub)
- [ ] Метрики Prometheus + Grafana
- [ ] Аватары через MinIO
- [ ] Запись звонков
- [ ] Демонстрация экрана
- [ ] Push-уведомления
- [ ] E2E-тесты Playwright
- [ ] Production TLS (Traefik + Let's Encrypt)
- [ ] Rate limiting

## Разработка

Каждый сервис можно запускать локально (без Docker):
```bash
cd services/auth-service
pip install -e .
uvicorn app.main:app --reload --port 8001
```
