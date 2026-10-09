FROM python:3.11-slim

# TORCH_INDEX: cpu (padrão) ou cu121 para GPU NVIDIA
ARG TORCH_INDEX=cpu

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# torch/torchaudio fixados: torchaudio >= 2.9 exige torchcodec e quebra o demucs 4.0.1
RUN pip install --no-cache-dir torch==2.5.1 torchaudio==2.5.1 \
    --index-url https://download.pytorch.org/whl/${TORCH_INDEX}

# runtime JS exigido pelo yt-dlp para resolver os desafios do YouTube (EJS)
COPY --from=denoland/deno:bin /deno /usr/local/bin/deno

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY singalong_worker ./singalong_worker

ENV TORCH_HOME=/models \
    WHISPER_CACHE=/models/whisper \
    STORAGE_ROOT=/storage \
    PYTHONUNBUFFERED=1

RUN useradd -m worker && mkdir -p /models /storage && chown worker /models /storage
USER worker

ENTRYPOINT ["python", "-m", "singalong_worker"]
