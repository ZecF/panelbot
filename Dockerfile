# Menggunakan image resmi Node.js v20 berbasis Debian Bullseye
FROM node:20-bullseye

# Install FFmpeg, ImageMagick, WebP, Git, Python3, Nano, dan utilitas ala Termux
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
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Set direktori utama panel
WORKDIR /app

# Copy package.json dan install dependency panel
COPY package*.json ./
RUN npm install

# Copy seluruh kode panel
COPY . .

# Buat folder workspace untuk menampung script bot WA yang di-upload
RUN mkdir -p /app/workspace

# Jalankan server panel
CMD ["node", "server.js"]
