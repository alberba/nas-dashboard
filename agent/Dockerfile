FROM python:3.14-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      util-linux smartmontools git systemd \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir pyyaml==6.0.3
WORKDIR /app
COPY server.py maintenance.py maintenance_actions.py deployments.py lifecycle.py logs.py host_commands.py smart.py \
     test_files.py test_maintenance.py test_maintenance_actions.py test_deployments.py test_logs.py test_host_commands.py test_smart.py ./
CMD ["python", "-u", "server.py"]
