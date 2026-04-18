FROM node:20-slim

# 安装必要的系统依赖 (如 git，用于一些核心包的操作)
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

# 设置工作目录
WORKDIR /app

# 复制依赖定义并安装
COPY package*.json ./
RUN npm install --production

# 复制所有源代码
COPY . .

# Hugging Face Spaces 规范：
# 1. 必须使用非 root 用户 (HF 默认提供 UID 1000)
# 2. 默认端口为 7860
RUN useradd -m -u 1000 user
USER user
ENV HOME=/home/user \
	PATH=/home/user/.local/bin:$PATH \
    PORT=7860

# 设置 InkOS 的主目录到用户目录下以保证读写权限
ENV INKOS_HOME=/home/user/.inkos
RUN mkdir -p /home/user/.inkos

WORKDIR $HOME/app
COPY --chown=user . $HOME/app

EXPOSE 7860

# 启动服务
CMD ["node", "src/server.js"]
