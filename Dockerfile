FROM node:22-bookworm-slim

ENV NODE_ENV=production
ENV SHOTBOARD_CHROME_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_DOWNLOAD=true

RUN apt-get update \
  && apt-get install --yes --no-install-recommends \
    chromium \
    ca-certificates \
    fonts-liberation \
    fonts-noto-color-emoji \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --shell /bin/bash shotboard

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN chown -R shotboard:shotboard /app
USER shotboard

EXPOSE 10000
CMD ["npm", "start"]
