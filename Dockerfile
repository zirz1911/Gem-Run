FROM node:22-bookworm-slim

WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --chown=node:node . .
RUN mkdir -p /app/data && chown node:node /app/data

USER node
EXPOSE 3200
CMD ["npm", "start"]
