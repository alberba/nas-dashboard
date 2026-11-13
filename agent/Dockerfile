FROM python:3.14-slim
COPY requirements.txt /tmp/agent-requirements.txt
RUN apt-get update && apt-get install -y --no-install-recommends \
      util-linux smartmontools git systemd \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir -r /tmp/agent-requirements.txt
WORKDIR /app
COPY server.py maintenance.py maintenance_actions.py deployments.py lifecycle.py logs.py host_commands.py smart.py env_settings.py \
     test_files.py test_maintenance.py test_maintenance_actions.py test_deployments.py test_logs.py test_host_commands.py test_smart.py test_env_settings.py ./
CMD ["python", "-u", "server.py"]
