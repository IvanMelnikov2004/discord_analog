FROM python:3.11-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PIP_NO_CACHE_DIR=1

COPY libs/shared-py /libs/shared-py
RUN pip install -e /libs/shared-py

COPY services/channel-service/pyproject.toml ./
RUN pip install -e .

COPY services/channel-service/app ./app
COPY services/channel-service/alembic ./alembic
COPY services/channel-service/alembic.ini ./

COPY infrastructure/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8000
ENTRYPOINT ["/entrypoint.sh"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
