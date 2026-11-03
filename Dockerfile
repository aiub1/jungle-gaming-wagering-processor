FROM oven/bun:1.4-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY tsconfig.json ./
COPY src ./src
USER bun
EXPOSE 3000
# exec form: o processo bun recebe o SIGTERM diretamente (graceful shutdown)
CMD ["bun", "src/main.ts"]
