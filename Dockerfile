FROM debian:stable-slim

# Install system dependencies
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    libreoffice \
    libreoffice-writer \
    libreoffice-calc \
    libreoffice-impress \
    python3-uno \
    fonts-dejavu \
    ghostscript \
    poppler-utils \
    qpdf \
    unzip \
    wget \
    ca-certificates && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy package.json first
COPY package*.json ./

RUN npm install

# Copy rest of the application
COPY . .

# Expose port
EXPOSE 10000

# Run the server
CMD ["node", "server.js"]
