FROM python:3.11-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PIP_NO_CACHE_DIR=1

COPY libs/shared-py /libs/shared-py
RUN pip install -e /libs/shared-py

COPY services/message-service/pyproject.toml ./
RUN pip install -e .

COPY services/message-service/app ./app

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
