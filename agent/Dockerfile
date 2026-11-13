FROM python:3.14-slim
RUN apt-get update && apt-get install -y --no-install-recommends util-linux && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server.py maintenance.py maintenance_actions.py lifecycle.py logs.py host_commands.py test_files.py test_maintenance.py test_maintenance_actions.py test_logs.py test_host_commands.py ./
CMD ["python", "-u", "server.py"]
