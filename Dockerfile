FROM python:3.10-slim

# 1. 基础依赖（OpenCV/FFmpeg 等）
RUN apt-get update && apt-get install -y \
    git \
    ffmpeg \
    libsm6 \
    libxext6 \
    && rm -rf /var/lib/apt/lists/*

# 2. 工作目录
WORKDIR /app

# 3. 先复制依赖文件，利用构建缓存
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# 4. 复制项目代码
COPY . /app

# 5. 环境变量
ENV PYTHONUNBUFFERED=1 \
    TZ=Asia/Shanghai

# 6. 默认启动命令（可按需修改为你的实际入口）
# 比如你之后创建 run_multicam_heatmap.py 作为主程序
CMD ["python", "run_multicam_heatmap.py"]

