FROM python:3.10-slim

RUN apt-get update && apt-get install -y \
    git \
    ffmpeg \
    libsm6 \
    libxext6 \
    tzdata \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt /app/requirements.txt
# 安装 CUDA 版 PyTorch（让 ultralytics 能用 GPU）
# 注意：需要宿主机 + Docker 已启用 NVIDIA GPU 支持
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cu124 torch torchvision torchaudio
RUN pip install --no-cache-dir -r requirements.txt

COPY . /app

ENV PYTHONUNBUFFERED=1 \
    TZ=Asia/Shanghai

RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]

