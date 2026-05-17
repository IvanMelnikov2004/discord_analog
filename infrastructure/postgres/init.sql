-- Каждый сервис получает свою базу для изоляции
CREATE DATABASE auth_db;
CREATE DATABASE user_db;
CREATE DATABASE channel_db;

GRANT ALL PRIVILEGES ON DATABASE auth_db TO messenger;
GRANT ALL PRIVILEGES ON DATABASE user_db TO messenger;
GRANT ALL PRIVILEGES ON DATABASE channel_db TO messenger;
