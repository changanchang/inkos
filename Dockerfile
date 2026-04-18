FROM node:20-slim

# 安装必要的系统依赖 (如 git)
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

# 设置工作目录
WORKDIR /app

# 复制依赖定义并安装
COPY package*.json ./
RUN npm install --production

# 复制所有源代码
COPY . .

# Hugging Face Spaces 规范：
# 1. 必须使用非 root 用户 (UID 1000)
# 2. 默认端口为 7860
RUN useradd -m -u 1000 user || echo "User already exists"

# 设置环境变量
ENV PORT=7860
ENV NODE_ENV=production
ENV INKOS_HOME=/home/user/.inkos

# 创建持久化目录并授权
RUN mkdir -p /home/user/.inkos && chown -R user:user /home/user/.inkos && chown -R user:user /app

USER user

EXPOSE 7860

# 启动服务
CMD ["node", "src/server.js"]
