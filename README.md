# Neunovapdf Backend (v1)

This backend provides API endpoints used by the Neunovapdf frontend. It includes implementations for several PDF operations (merge, split, extract, jpg->pdf).

## What's included
- Express server (server.js)
- Multer (memory storage) for uploads
- pdf-lib used for PDF manipulations (merge, split, extract)
- PDFKit used for JPG->PDF conversion
- Swagger UI at `/api-docs` (serves swagger.yaml)
- Placeholders for operations requiring external binaries (LibreOffice, qpdf, ghostscript). See notes below.

## Install
```bash
npm install
```

## Run locally
```bash
npm start
# server listens on port 3000 by default
```

## Deploy on Render
1. Create a new Web Service on Render (Connect GitHub repo or upload).
2. Build Command: `npm install`
3. Start Command: `npm start`
4. Ensure your service has at least 512MB disk and allows installing optional binaries if you need LibreOffice/qpdf/ghostscript.

### Important: External dependencies
Some conversions (Word/Excel/PPT <-> PDF, PDF->JPG, Protect/Unlock/Compress proper implementation) require external command-line tools:
- **LibreOffice (soffice)** — required for DOCX/XLSX/PPTX conversions.
- **qpdf / ghostscript** — required for password-protect/unlock and advanced compression.
- **poppler / pdftoppm** — for PDF -> JPG rasterization.

On Render, these binaries are not present by default. If you need full conversion support, you should deploy using a Docker service with those tools installed, or use a third-party conversion API.

## Endpoints
- `POST /api/merge` - form field `files[]` - returns merged PDF
- `POST /api/split` - form field `file`, optional `pages` - returns ZIP of selected pages
- `POST /api/extract` - form field `file`, `pages` - returns PDF
- `POST /api/compress` - placeholder (returns original or requires ghostscript)
- `POST /api/pdf2jpg` - not implemented (requires poppler/ghostscript)
- `POST /api/jpg2pdf` - form field `images[]` - returns PDF
- `POST /api/word2pdf` - not implemented (requires LibreOffice)
- `POST /api/excel2pdf` - not implemented (requires LibreOffice)
- `POST /api/ppt2pdf` - not implemented (requires LibreOffice)
- `POST /api/pdf2word` - not implemented
- `POST /api/pdf2excel` - not implemented
- `POST /api/pdf2ppt` - not implemented
- `POST /api/protect` - not implemented (requires qpdf)
- `POST /api/unlock` - not implemented (requires qpdf)

## Notes for Render deployment
- If you need full support for Office conversions and image rasterization, create a Dockerfile that installs LibreOffice, qpdf, ghostscript, and poppler utilities.
- This repository is ready for basic PDF tasks. Advanced production-ready conversion requires adding those binaries or using paid APIs.

## Security
- The server stores uploads only in memory or temporary files and deletes temporary files after processing.
- Apply rate limits, authentication, and malware scans for production deployments.

