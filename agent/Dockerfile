FROM python:3.14-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      util-linux git systemd \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir pyyaml==6.0.3
WORKDIR /app
COPY server.py maintenance.py deployments.py lifecycle.py logs.py \
     test_files.py test_maintenance.py test_deployments.py test_logs.py ./
CMD ["python", "-u", "server.py"]
