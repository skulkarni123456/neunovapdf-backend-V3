// Neunovapdf Backend - server.js
const express = require('express');
const multer = require('multer');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const PDFDocumentWriter = require('pdf-lib'); // alias
const PDFKit = require('pdfkit');
const archiver = require('archiver');
const fs = require('fs');
const path = require('path');
const os = require('os');
const util = require('util');
const stream = require('stream');
const finished = util.promisify(stream.finished);
const swaggerUi = require('swagger-ui-express');
const YAML = require('yamljs');
const morgan = require('morgan');
const cors = require('cors');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB limit
const app = express();
app.use(express.json());
app.use(cors());
app.use(morgan('combined'));

const swaggerDocument = YAML.load(path.join(__dirname, 'swagger.yaml'));
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

function bufferToStream(buffer) {
  const s = new stream.PassThrough();
  s.end(buffer);
  return s;
}

async function mergePDFBuffers(buffers) {
  const mergedPdf = await PDFDocument.create();
  for (const buf of buffers) {
    const pdf = await PDFDocument.load(buf);
    const copied = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
    copied.forEach((p) => mergedPdf.addPage(p));
  }
  const out = await mergedPdf.save();
  return out;
}

async function splitPDFBuffer(buffer, pagesSpec) {
  // pagesSpec like '1-3,5'
  const pdf = await PDFDocument.load(buffer);
  const total = pdf.getPageCount();
  let pages = [];
  if (!pagesSpec) {
    // default: split each page into separate PDF and return zip buffer
    for (let i=0;i<total;i++) pages.push([i]);
  } else {
    // parse ranges
    const parts = pagesSpec.split(',').map(p=>p.trim());
    for (const part of parts) {
      if (part.includes('-')) {
        const [s,e] = part.split('-').map(x=>parseInt(x.trim(),10));
        for (let i = Math.max(1,s); i <= Math.min(total,e); i++) pages.push([i-1]);
      } else {
        const n = parseInt(part,10);
        if (!isNaN(n) && n>=1 && n<=total) pages.push([n-1]);
      }
    }
  }
  // create zip of extracted pages (each as single PDF)
  const tmpFile = path.join(os.tmpdir(), `extracted_${Date.now()}.zip`);
  const output = fs.createWriteStream(tmpFile);
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.pipe(output);
  for (let i=0;i<pages.length;i++) {
    const newPdf = await PDFDocument.create();
    const src = await PDFDocument.load(buffer);
    const copied = await newPdf.copyPages(src, pages[i]);
    copied.forEach(p=>newPdf.addPage(p));
    const pdfBytes = await newPdf.save();
    archive.append(Buffer.from(pdfBytes), { name: `extracted_${i+1}.pdf` });
  }
  await archive.finalize();
  await finished(output);
  const zipBuf = fs.readFileSync(tmpFile);
  fs.unlinkSync(tmpFile);
  return zipBuf;
}

async function extractPagesBuffer(buffer, pagesSpec) {
  // single output PDF with selected pages
  const pdf = await PDFDocument.load(buffer);
  const total = pdf.getPageCount();
  let indices = [];
  if (!pagesSpec) {
    indices = pdf.getPageIndices();
  } else {
    const parts = pagesSpec.split(',').map(p=>p.trim());
    for (const part of parts) {
      if (part.includes('-')) {
        const [s,e] = part.split('-').map(x=>parseInt(x.trim(),10));
        for (let i = Math.max(1,s); i <= Math.min(total,e); i++) indices.push(i-1);
      } else {
        const n = parseInt(part,10);
        if (!isNaN(n) && n>=1 && n<=total) indices.push(n-1);
      }
    }
  }
  const newPdf = await PDFDocument.create();
  const src = await PDFDocument.load(buffer);
  const copied = await newPdf.copyPages(src, indices);
  copied.forEach(p=>newPdf.addPage(p));
  const out = await newPdf.save();
  return out;
}

async function protectPdfBuffer(buffer, password) {
  // pdf-lib does not yet support encryption in JS runtime reliably;
  // As a fallback, we return 501 with instructions.
  throw new Error('Protection requires external tool (qpdf or ghostscript).');
}

async function unlockPdfBuffer(buffer, password) {
  throw new Error('Unlock requires external tool (qpdf or ghostscript).');
}

async function compressPdfBuffer(buffer, level) {
  // No reliable pure-JS lossy compression. Return original for now or use external gs.
  // We'll return original as placeholder.
  return buffer;
}

// ROUTES

app.post('/api/merge', upload.array('files'), async (req, res) => {
  try {
    const files = req.files || [];
    if (files.length === 0) return res.status(400).json({ error: 'No files uploaded' });
    const buffers = files.map(f => f.buffer);
    const out = await mergePDFBuffers(buffers);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename=merged.pdf');
    res.send(Buffer.from(out));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/split', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    const pages = req.body.pages || '';
    if (!file) return res.status(400).json({ error: 'No file uploaded' });
    // create zip of single pages or ranges
    const zipBuf = await splitPDFBuffer(file.buffer, pages);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename=split.zip');
    res.send(zipBuf);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/extract', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    const pages = req.body.pages || '';
    if (!file) return res.status(400).json({ error: 'No file uploaded' });
    const out = await extractPagesBuffer(file.buffer, pages);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename=extracted.pdf');
    res.send(Buffer.from(out));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/compress', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    const level = req.body.level || 'medium';
    if (!file) return res.status(400).json({ error: 'No file uploaded' });
    // placeholder: returning original file
    const out = await compressPdfBuffer(file.buffer, level);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename=compressed.pdf');
    res.send(Buffer.from(out));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/pdf2jpg', upload.single('file'), async (req, res) => {
  // Requires external tool (poppler/ghostscript). Return 501 with message.
  res.status(501).json({ error: 'pdf2jpg requires external binary (poppler/ghostscript). See README.' });
});

app.post('/api/jpg2pdf', upload.array('images'), async (req, res) => {
  try {
    const files = req.files || [];
    if (files.length === 0) return res.status(400).json({ error: 'No images uploaded' });
    // Create a single PDF with images (simple)
    const doc = new PDFKit({ autoFirstPage: false });
    const tmpPath = path.join(os.tmpdir(), `jpg2pdf_${Date.now()}.pdf`);
    const outStream = fs.createWriteStream(tmpPath);
    doc.pipe(outStream);
    for (const f of files) {
      try {
        const img = doc.openImage(f.buffer);
        doc.addPage({ size: [img.width, img.height] });
        doc.image(img, 0, 0);
      } catch (e) {
        // fallback: add a page and write filename
        doc.addPage();
        doc.fontSize(12).text('Unable to render image: ' + f.originalname);
      }
    }
    doc.end();
    await finished(outStream);
    const buf = fs.readFileSync(tmpPath);
    fs.unlinkSync(tmpPath);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename=converted.pdf');
    res.send(buf);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/word2pdf', upload.single('file'), async (req, res) => {
  res.status(501).json({ error: 'word2pdf requires LibreOffice (soffice) on the server. See README.' });
});
app.post('/api/excel2pdf', upload.single('file'), async (req, res) => {
  res.status(501).json({ error: 'excel2pdf requires LibreOffice (soffice) on the server. See README.' });
});
app.post('/api/ppt2pdf', upload.single('file'), async (req, res) => {
  res.status(501).json({ error: 'ppt2pdf requires LibreOffice (soffice) on the server. See README.' });
});
app.post('/api/pdf2word', upload.single('file'), async (req, res) => {
  res.status(501).json({ error: 'pdf2word requires external tools (OCR/LibreOffice). See README.' });
});
app.post('/api/pdf2excel', upload.single('file'), async (req, res) => {
  res.status(501).json({ error: 'pdf2excel requires external tools. See README.' });
});
app.post('/api/pdf2ppt', upload.single('file'), async (req, res) => {
  res.status(501).json({ error: 'pdf2ppt requires external tools. See README.' });
});

app.post('/api/protect', upload.single('file'), async (req, res) => {
  try {
    // placeholder - requires qpdf or ghostscript
    res.status(501).json({ error: 'Protect PDF requires qpdf or ghostscript installed on the server.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/unlock', upload.single('file'), async (req, res) => {
  try {
    res.status(501).json({ error: 'Unlock PDF requires qpdf or ghostscript installed on the server.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Health
app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Neunovapdf backend listening on', PORT));
