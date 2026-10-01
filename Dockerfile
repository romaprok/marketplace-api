FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY openapi ./openapi
COPY scripts ./scripts
COPY src ./src
COPY .env.example ./

# .env and secrets/ are never copied — see .dockerignore.

EXPOSE 3000

CMD ["node", "src/server.js"]
