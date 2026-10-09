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

# separa a voz isolada em principal x vozes de apoio (modelos "karaokê" do UVR, MDX-Net). `--no-deps` porque o pacote puxa
# o diffq (só dos modelos Demucs), que precisa de compilador; o resto é o que os modelos MDX-Net usam. O modelo (~53 MB)
# baixa na primeira vez para o volume /models.
# ATENÇÃO com o torch: o onnx2torch exige o torchvision, e o torchvision mais novo puxaria o torch 2.14 (com CUDA 13, +4 GB),
# que quebra o Demucs. Por isso o torchvision compatível com o torch 2.5.1 entra antes, pelo mesmo índice, e a última linha
# FALHA o build se alguma coisa mudar a versão do torch.
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
