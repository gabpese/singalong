FROM python:3.11-slim

# TORCH_INDEX: cpu (default) or cu121 for an NVIDIA GPU
ARG TORCH_INDEX=cpu

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# torch/torchaudio pinned: torchaudio >= 2.9 requires torchcodec and breaks demucs 4.0.1
RUN pip install --no-cache-dir torch==2.5.1 torchaudio==2.5.1 \
    --index-url https://download.pytorch.org/whl/${TORCH_INDEX}

# the JS runtime yt-dlp requires to solve YouTube's challenges (EJS)
COPY --from=denoland/deno:bin /deno /usr/local/bin/deno

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# splits the isolated vocals into lead x backing vocals (UVR's "karaoke" models, MDX-Net). `--no-deps` because the package
# pulls diffq (for the Demucs models only), which needs a compiler; the rest is what the MDX-Net models use. The model
# (~53 MB) downloads into the /models volume the first time.
# MIND torch: onnx2torch requires torchvision, and the newest torchvision would pull torch 2.14 (with CUDA 13, +4 GB), which
# breaks Demucs. So the torchvision that matches torch 2.5.1 goes in first, from the same index, and the last line FAILS the
# build if anything changes the torch version.
RUN pip install --no-cache-dir --no-deps torchvision==0.20.1 --index-url https://download.pytorch.org/whl/${TORCH_INDEX} \
    && pip install --no-cache-dir --no-deps audio-separator==0.47.0 \
    && pip install --no-cache-dir onnxruntime==1.31.0 onnx2torch==1.5.15 ml_collections==1.1.0 rotary-embedding-torch==0.9.1 \
        beartype==0.22.9 einops==0.8.2 julius==0.2.8 samplerate==0.2.4 pydub==0.25.1 pyyaml requests tqdm six \
    && python -c "import torch, torchaudio, torchvision; assert torch.__version__.startswith('2.5.1'), torch.__version__; print('torch', torch.__version__, torchaudio.__version__, torchvision.__version__)"

COPY singalong_worker ./singalong_worker

ENV TORCH_HOME=/models \
    WHISPER_CACHE=/models/whisper \
    STORAGE_ROOT=/storage \
    PYTHONUNBUFFERED=1 \
    LOG_FORMAT=json

RUN useradd -m worker && mkdir -p /models /storage && chown worker /models /storage
USER worker

ENTRYPOINT ["python", "-m", "singalong_worker"]
