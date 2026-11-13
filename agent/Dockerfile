FROM python:3.14-slim
RUN apt-get update && apt-get install -y --no-install-recommends util-linux && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server.py maintenance.py test_files.py test_maintenance.py ./
CMD ["python", "-u", "server.py"]
