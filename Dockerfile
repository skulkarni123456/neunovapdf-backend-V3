# Neunovapdf Dockerfile - Ubuntu-based with LibreOffice, Ghostscript, QPDF and Poppler
FROM node:20-bullseye

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
  libreoffice-writer libreoffice-core libreoffice-common libreoffice-calc libreoffice-impress \
  ghostscript qpdf poppler-utils imagemagick tesseract-ocr poppler-utils \
  fonts-dejavu-core \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --production

COPY . .
EXPOSE 3000
CMD ["node","server.js"]
