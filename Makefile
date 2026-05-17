.PHONY: help up down restart logs build migrate clean

help:
	@echo "Available commands:"
	@echo "  make up        - Start all services (migrations run automatically)"
	@echo "  make down      - Stop all services"
	@echo "  make restart   - Restart all services"
	@echo "  make logs      - Follow logs"
	@echo "  make build     - Rebuild all images"
	@echo "  make migrate   - Force-run migrations (usually not needed)"
	@echo "  make clean     - Stop and remove volumes (destroys all data)"

up:
	docker compose up -d

down:
	docker compose down

restart:
	docker compose restart

logs:
	docker compose logs -f

build:
	docker compose build

# Migrations run automatically on container start via entrypoint.sh.
# Use this only if you need to force-rerun them.
migrate:
	docker compose exec auth-service alembic upgrade head
	docker compose exec user-service alembic upgrade head
	docker compose exec channel-service alembic upgrade head

clean:
	docker compose down -v
