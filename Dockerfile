FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY src ./src

ENV PORT=8080
ENV LM_STUDIO_BASE_URL=http://host.docker.internal:1234

EXPOSE 8080

CMD ["node", "src/server.js"]
