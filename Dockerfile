FROM node:20-bullseye

RUN apt-get update && apt-get install -y \
    ffmpeg \
    imagemagick \
    webp \
    git \
    curl \
    wget \
    nano \
    unzip \
    python3 \
    python3-pip \
    build-essential \
    procps \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

RUN mkdir -p /app/workspace

CMD ["node", "server.js"]
