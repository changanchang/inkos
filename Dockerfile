FROM node:20

# 设置工作目录
WORKDIR /app

# 复制依赖定义并安装
COPY --chown=node:node package*.json ./
RUN npm install

# 复制所有源代码
COPY --chown=node:node . .

# 设置环境变量
ENV PORT=7860
ENV NODE_ENV=production
ENV INKOS_HOME=/app/.inkos

# 创建持久化目录
RUN mkdir -p /app/.inkos && chown -R node:node /app/.inkos

# 使用 node 用户运行 (UID 1000, HF 推荐)
USER node

EXPOSE 7860

# 启动服务
CMD ["node", "src/server.js"]
