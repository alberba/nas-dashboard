FROM python:3.14-slim
RUN apt-get update && apt-get install -y --no-install-recommends util-linux smartmontools && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server.py maintenance.py lifecycle.py logs.py host_commands.py smart.py test_files.py test_maintenance.py test_logs.py test_host_commands.py test_smart.py ./
CMD ["python", "-u", "server.py"]
