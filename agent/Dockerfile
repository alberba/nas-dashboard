FROM python:3.14-slim
COPY requirements.txt /tmp/agent-requirements.txt
RUN apt-get update && apt-get install -y --no-install-recommends \
      util-linux smartmontools git systemd \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir -r /tmp/agent-requirements.txt
WORKDIR /app
COPY server.py maintenance.py helper_cleanup.py maintenance_actions.py deployments.py lifecycle.py logs.py host_commands.py smart.py env_settings.py updates.py host_metrics.py \
     test_files.py test_maintenance.py test_maintenance_actions.py test_deployments.py test_logs.py test_host_commands.py test_smart.py test_env_settings.py test_updates.py test_host_metrics.py test_metrics.py ./
# The same image serves both Compose configurations. The probe is read-only,
# local to the container tmpfs and fails when the serve loop stops publishing
# progress or the protected LOCK stays taken.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["python", "server.py", "--health-check"]
CMD ["python", "-u", "server.py"]
