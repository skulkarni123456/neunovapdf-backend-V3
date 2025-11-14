// Neunovapdf Backend (Docker-ready) - server.js
const express = require('express');
const multer = require('multer');
const { PDFDocument } = require('pdf-lib');
const PDFKit = require('pdfkit');
const archiver = require('archiver');
const fs = require('fs');
const path = require('path');
const os = require('os');
const util = require('util');
const stream = require('stream');
const child = require('child_process');
const finished = util.promisify(stream.finished);
const swaggerUi = require('swagger-ui-express');
const YAML = require('yamljs');
const morgan = require('morgan');
const cors = require('cors');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } }); // 200MB
const app = express();
app.use(express.json());
app.use(cors());
app.use(morgan('combined'));

const swaggerDocument = YAML.load(path.join(__dirname, 'swagger.yaml'));
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

function bufferToTempFile(buffer, filenamePrefix){
  const tmpPath = path.join(os.tmpdir(), `${filenamePrefix}_${Date.now()}`);
  fs.writeFileSync(tmpPath, buffer);
  return tmpPath;
}

async function mergePDFBuffers(buffers){
  const mergedPdf = await PDFDocument.create();
  for(const buf of buffers){
    const pdf = await PDFDocument.load(buf);
    const copied = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
    copied.forEach(p => mergedPdf.addPage(p));
  }
  const out = await mergedPdf.save();
  return out;
}

async function extractPagesBuffer(buffer, pagesSpec){
  const pdf = await PDFDocument.load(buffer);
  const total = pdf.getPageCount();
  let indices = [];
  if(!pagesSpec){
    indices = pdf.getPageIndices();
  } else {
    const parts = pagesSpec.split(',').map(s=>s.trim());
    for(const part of parts){
      if(part.includes('-')){
        const [s,e] = part.split('-').map(x=>parseInt(x));
        for(let i = Math.max(1,s); i<=Math.min(total,e); i++) indices.push(i-1);
      } else {
        const n = parseInt(part);
        if(!isNaN(n) && n>=1 && n<=total) indices.push(n-1);
      }
    }
  }
  const newPdf = await PDFDocument.create();
  const src = await PDFDocument.load(buffer);
  const copied = await newPdf.copyPages(src, indices);
  copied.forEach(p => newPdf.addPage(p));
  return await newPdf.save();
}

// Routes

app.post('/api/merge', upload.array('files'), async (req,res)=>{
  try{
    const files = req.files || [];
    if(files.length===0) return res.status(400).json({error:'No files uploaded'});
    const buffers = files.map(f=>f.buffer);
    const out = await mergePDFBuffers(buffers);
    res.setHeader('Content-Type','application/pdf');
    res.setHeader('Content-Disposition','attachment; filename=merged.pdf');
    res.send(Buffer.from(out));
  }catch(err){ console.error(err); res.status(500).json({error:err.message}); }
});

app.post('/api/split', upload.single('file'), async (req,res)=>{
  try{
    const file = req.file;
    const pages = req.body.pages || '';
    if(!file) return res.status(400).json({error:'No file uploaded'});
    // If pages empty -> split each page into separate pdfs zipped
    const pdf = await PDFDocument.load(file.buffer);
    const total = pdf.getPageCount();
    const tmpZip = path.join(os.tmpdir(), `split_${Date.now()}.zip`);
    const output = fs.createWriteStream(tmpZip);
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(output);
    const ranges = [];
    if(!pages){
      for(let i=0;i<total;i++) ranges.push([i]);
    } else {
      const parts = pages.split(',').map(p=>p.trim());
      for(const part of parts){
        if(part.includes('-')){
          const [s,e] = part.split('-').map(x=>parseInt(x));
          for(let i=Math.max(1,s); i<=Math.min(total,e); i++) ranges.push([i-1]);
        } else {
          const n = parseInt(part);
          if(!isNaN(n) && n>=1 && n<=total) ranges.push([n-1]);
        }
      }
    }
    for(let i=0;i<ranges.length;i++){
      const newPdf = await PDFDocument.create();
      const src = await PDFDocument.load(file.buffer);
      const copied = await newPdf.copyPages(src, ranges[i]);
      copied.forEach(p=>newPdf.addPage(p));
      const pdfBytes = await newPdf.save();
      archive.append(Buffer.from(pdfBytes), { name: `extracted_${i+1}.pdf` });
    }
    await archive.finalize();
    await finished(output);
    const zipBuf = fs.readFileSync(tmpZip);
    fs.unlinkSync(tmpZip);
    res.setHeader('Content-Type','application/zip');
    res.setHeader('Content-Disposition','attachment; filename=split.zip');
    res.send(zipBuf);
  }catch(err){ console.error(err); res.status(500).json({error:err.message}); }
});

app.post('/api/extract', upload.single('file'), async (req,res)=>{
  try{
    const file = req.file;
    const pages = req.body.pages || '';
    if(!file) return res.status(400).json({error:'No file uploaded'});
    const out = await extractPagesBuffer(file.buffer, pages);
    res.setHeader('Content-Type','application/pdf');
    res.setHeader('Content-Disposition','attachment; filename=extracted.pdf');
    res.send(Buffer.from(out));
  }catch(err){ console.error(err); res.status(500).json({error:err.message}); }
});

app.post('/api/compress', upload.single('file'), async (req,res)=>{
  try{
    const file = req.file;
    const level = req.body.level || 'medium';
    if(!file) return res.status(400).json({error:'No file uploaded'});
    // Use ghostscript to compress - write input file to tmp, run gs, return output
    const inPath = bufferToTempFile(file.buffer, 'inpdf');
    const outPath = path.join(os.tmpdir(), `out_${Date.now()}.pdf`);
    // Choose PDFSETTINGS based on level
    let setting = '/ebook';
    if(level==='high') setting = '/prepress';
    if(level==='low') setting = '/screen';
    const args = ['-sDEVICE=pdfwrite','-dCompatibilityLevel=1.4',`-dPDFSETTINGS=${setting}`,'-dNOPAUSE','-dQUIET','-dBATCH',`-sOutputFile=${outPath}`,inPath];
    try{
      child.execFileSync('gs', args);
      const buf = fs.readFileSync(outPath);
      fs.unlinkSync(inPath); fs.unlinkSync(outPath);
      res.setHeader('Content-Type','application/pdf');
      res.setHeader('Content-Disposition','attachment; filename=compressed.pdf');
      res.send(buf);
    }catch(e){
      // cleanup and fallback to original
      if(fs.existsSync(inPath)) fs.unlinkSync(inPath);
      if(fs.existsSync(outPath)) fs.unlinkSync(outPath);
      console.error(e);
      return res.status(500).json({error:'Compression failed: '+e.message});
    }
  }catch(err){ console.error(err); res.status(500).json({error:err.message}); }
});

app.post('/api/pdf2jpg', upload.single('file'), async (req,res)=>{
  try{
    const file = req.file;
    if(!file) return res.status(400).json({error:'No file uploaded'});
    const inPath = bufferToTempFile(file.buffer, 'inpdf');
    const outPrefix = path.join(os.tmpdir(), `page_${Date.now()}`);
    // pdftoppm -jpeg in.pdf out_prefix
    try{
      child.execFileSync('pdftoppm', ['-jpeg', inPath, outPrefix]);
      // collect files matching outPrefix-*.jpg (pdftoppm produces outPrefix-1.jpg etc)
      const dir = os.tmpdir();
      const files = fs.readdirSync(dir).filter(f=>f.startsWith(path.basename(outPrefix)));
      // create zip
      const tmpZip = path.join(os.tmpdir(), `pages_${Date.now()}.zip`);
      const output = fs.createWriteStream(tmpZip);
      const archive = archiver('zip', { zlib: { level: 9 } });
      archive.pipe(output);
      for(const fname of files){
        const full = path.join(dir, fname);
        archive.file(full, { name: fname });
      }
      await archive.finalize();
      await finished(output);
      // cleanup images and inPath
      for(const fname of files){ try{ fs.unlinkSync(path.join(dir,fname)); }catch(e){} }
      if(fs.existsSync(inPath)) fs.unlinkSync(inPath);
      const zipBuf = fs.readFileSync(tmpZip);
      fs.unlinkSync(tmpZip);
      res.setHeader('Content-Type','application/zip');
      res.setHeader('Content-Disposition','attachment; filename=pages.zip');
      res.send(zipBuf);
    }catch(e){
      if(fs.existsSync(inPath)) fs.unlinkSync(inPath);
      console.error(e);
      res.status(500).json({error:'pdf2jpg failed: '+e.message});
    }
  }catch(err){ console.error(err); res.status(500).json({error:err.message}); }
});

app.post('/api/jpg2pdf', upload.array('images'), async (req,res)=>{
  try{
    const files = req.files || [];
    if(files.length===0) return res.status(400).json({error:'No images uploaded'});
    const tmpPath = path.join(os.tmpdir(), `jpg2pdf_${Date.now()}.pdf`);
    const doc = new PDFKit({ autoFirstPage:false });
    const outStream = fs.createWriteStream(tmpPath);
    doc.pipe(outStream);
    for(const f of files){
      try{
        const img = doc.openImage(f.buffer);
        doc.addPage({ size: [img.width, img.height] });
        doc.image(img, 0, 0);
      }catch(e){
        doc.addPage();
        doc.fontSize(12).text('Unable to render image: '+f.originalname);
      }
    }
    doc.end();
    await finished(outStream);
    const buf = fs.readFileSync(tmpPath);
    fs.unlinkSync(tmpPath);
    res.setHeader('Content-Type','application/pdf');
    res.setHeader('Content-Disposition','attachment; filename=converted.pdf');
    res.send(buf);
  }catch(err){ console.error(err); res.status(500).json({error:err.message}); }
});

// Office conversions using LibreOffice (soffice)
async function sofficeConvert(inPath, outDir){
  // Example: soffice --headless --convert-to pdf --outdir <outDir> <inPath>
  child.execFileSync('soffice',['--headless','--convert-to','pdf','--outdir',outDir,inPath],{stdio:'inherit'});
}

app.post('/api/word2pdf', upload.single('file'), async (req,res)=>{
  try{
    const file = req.file;
    if(!file) return res.status(400).json({error:'No file uploaded'});
    const inPath = bufferToTempFile(file.buffer,'inword');
    const outDir = os.tmpdir();
    try{
      sofficeConvert(inPath,outDir);
      // find converted pdf (same basename but .pdf)
      const outFile = path.join(outDir, path.basename(inPath) + '.pdf');
      // Note: LibreOffice may name differently; search for any pdf with timestamp
      const candidates = fs.readdirSync(outDir).filter(f=>f.endsWith('.pdf') && f.includes(path.basename(inPath)));
      const pdfFile = candidates.length? path.join(outDir,candidates[0]) : outFile;
      const buf = fs.readFileSync(pdfFile);
      // cleanup
      try{ fs.unlinkSync(inPath); }catch(e){};
      try{ fs.unlinkSync(pdfFile); }catch(e){};
      res.setHeader('Content-Type','application/pdf');
      res.setHeader('Content-Disposition','attachment; filename=converted.pdf');
      res.send(buf);
    }catch(e){
      if(fs.existsSync(inPath)) fs.unlinkSync(inPath);
      console.error(e);
      res.status(500).json({error:'word2pdf failed: '+e.message});
    }
  }catch(err){ console.error(err); res.status(500).json({error:err.message}); }
});

app.post('/api/excel2pdf', upload.single('file'), async (req,res)=>{
  try{
    const file = req.file;
    if(!file) return res.status(400).json({error:'No file uploaded'});
    const inPath = bufferToTempFile(file.buffer,'inexcel');
    const outDir = os.tmpdir();
    try{
      sofficeConvert(inPath,outDir);
      const candidates = fs.readdirSync(outDir).filter(f=>f.endsWith('.pdf') && f.includes(path.basename(inPath)));
      const pdfFile = candidates.length? path.join(outDir,candidates[0]) : path.join(outDir, path.basename(inPath)+'.pdf');
      const buf = fs.readFileSync(pdfFile);
      try{ fs.unlinkSync(inPath); }catch(e){};
      try{ fs.unlinkSync(pdfFile); }catch(e){};
      res.setHeader('Content-Type','application/pdf');
      res.setHeader('Content-Disposition','attachment; filename=converted.pdf');
      res.send(buf);
    }catch(e){
      if(fs.existsSync(inPath)) fs.unlinkSync(inPath);
      console.error(e);
      res.status(500).json({error:'excel2pdf failed: '+e.message});
    }
  }catch(err){ console.error(err); res.status(500).json({error:err.message}); }
});

app.post('/api/ppt2pdf', upload.single('file'), async (req,res)=>{
  try{
    const file = req.file;
    if(!file) return res.status(400).json({error:'No file uploaded'});
    const inPath = bufferToTempFile(file.buffer,'inppt');
    const outDir = os.tmpdir();
    try{
      sofficeConvert(inPath,outDir);
      const candidates = fs.readdirSync(outDir).filter(f=>f.endsWith('.pdf') && f.includes(path.basename(inPath)));
      const pdfFile = candidates.length? path.join(outDir,candidates[0]) : path.join(outDir, path.basename(inPath)+'.pdf');
      const buf = fs.readFileSync(pdfFile);
      try{ fs.unlinkSync(inPath); }catch(e){};
      try{ fs.unlinkSync(pdfFile); }catch(e){};
      res.setHeader('Content-Type','application/pdf');
      res.setHeader('Content-Disposition','attachment; filename=converted.pdf');
      res.send(buf);
    }catch(e){
      if(fs.existsSync(inPath)) fs.unlinkSync(inPath);
      console.error(e);
      res.status(500).json({error:'ppt2pdf failed: '+e.message});
    }
  }catch(err){ console.error(err); res.status(500).json({error:err.message}); }
});

// pdf -> word using libreoffice (best-effort)
app.post('/api/pdf2word', upload.single('file'), async (req,res)=>{
  try{
    const file = req.file;
    if(!file) return res.status(400).json({error:'No file uploaded'});
    const inPath = bufferToTempFile(file.buffer,'inpdf');
    const outDir = os.tmpdir();
    try{
      // libreoffice can convert pdf to docx in some cases
      child.execFileSync('soffice',['--headless','--convert-to','docx','--outdir',outDir,inPath],{stdio:'inherit'});
      const candidates = fs.readdirSync(outDir).filter(f=>f.endsWith('.docx') && f.includes(path.basename(inPath)));
      if(!candidates.length) throw new Error('Conversion not produced');
      const outFile = path.join(outDir,candidates[0]);
      const buf = fs.readFileSync(outFile);
      try{ fs.unlinkSync(inPath); }catch(e){};
      try{ fs.unlinkSync(outFile); }catch(e){};
      res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition','attachment; filename=converted.docx');
      res.send(buf);
    }catch(e){
      if(fs.existsSync(inPath)) fs.unlinkSync(inPath);
      console.error(e);
      res.status(500).json({error:'pdf2word failed: '+e.message});
    }
  }catch(err){ console.error(err); res.status(500).json({error:err.message}); }
});

app.post('/api/pdf2excel', upload.single('file'), async (req,res)=>{
  try{
    const file = req.file;
    if(!file) return res.status(400).json({error:'No file uploaded'});
    const inPath = bufferToTempFile(file.buffer,'inpdf');
    const outDir = os.tmpdir();
    try{
      child.execFileSync('soffice',['--headless','--convert-to','xlsx','--outdir',outDir,inPath],{stdio:'inherit'});
      const candidates = fs.readdirSync(outDir).filter(f=>f.endsWith('.xlsx') && f.includes(path.basename(inPath)));
      if(!candidates.length) throw new Error('Conversion not produced');
      const outFile = path.join(outDir,candidates[0]);
      const buf = fs.readFileSync(outFile);
      try{ fs.unlinkSync(inPath); }catch(e){};
      try{ fs.unlinkSync(outFile); }catch(e){};
      res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition','attachment; filename=converted.xlsx');
      res.send(buf);
    }catch(e){
      if(fs.existsSync(inPath)) fs.unlinkSync(inPath);
      console.error(e);
      res.status(500).json({error:'pdf2excel failed: '+e.message});
    }
  }catch(err){ console.error(err); res.status(500).json({error:err.message}); }
});

app.post('/api/pdf2ppt', upload.single('file'), async (req,res)=>{
  try{
    const file = req.file;
    if(!file) return res.status(400).json({error:'No file uploaded'});
    const inPath = bufferToTempFile(file.buffer,'inpdf');
    const outDir = os.tmpdir();
    try{
      child.execFileSync('soffice',['--headless','--convert-to','pptx','--outdir',outDir,inPath],{stdio:'inherit'});
      const candidates = fs.readdirSync(outDir).filter(f=>f.endsWith('.pptx') && f.includes(path.basename(inPath)));
      if(!candidates.length) throw new Error('Conversion not produced');
      const outFile = path.join(outDir,candidates[0]);
      const buf = fs.readFileSync(outFile);
      try{ fs.unlinkSync(inPath); }catch(e){};
      try{ fs.unlinkSync(outFile); }catch(e){};
      res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.presentationml.presentation');
      res.setHeader('Content-Disposition','attachment; filename=converted.pptx');
      res.send(buf);
    }catch(e){
      if(fs.existsSync(inPath)) fs.unlinkSync(inPath);
      console.error(e);
      res.status(500).json({error:'pdf2ppt failed: '+e.message});
    }
  }catch(err){ console.error(err); res.status(500).json({error:err.message}); }
});

// Protect / Unlock using qpdf
app.post('/api/protect', upload.single('file'), async (req,res)=>{
  try{
    const file = req.file; const password = req.body.password;
    if(!file) return res.status(400).json({error:'No file uploaded'});
    if(!password) return res.status(400).json({error:'Password required'});
    const inPath = bufferToTempFile(file.buffer,'inpdf');
    const outPath = path.join(os.tmpdir(), `protected_${Date.now()}.pdf`);
    try{
      child.execFileSync('qpdf', ['--encrypt', password, password, '256', '--', inPath, outPath], {stdio:'inherit'});
      const buf = fs.readFileSync(outPath);
      fs.unlinkSync(inPath); fs.unlinkSync(outPath);
      res.setHeader('Content-Type','application/pdf');
      res.setHeader('Content-Disposition','attachment; filename=protected.pdf');
      res.send(buf);
    }catch(e){
      if(fs.existsSync(inPath)) fs.unlinkSync(inPath);
      if(fs.existsSync(outPath)) fs.unlinkSync(outPath);
      console.error(e);
      res.status(500).json({error:'protect failed: '+e.message});
    }
  }catch(err){ console.error(err); res.status(500).json({error:err.message}); }
});

app.post('/api/unlock', upload.single('file'), async (req,res)=>{
  try{
    const file = req.file; const password = req.body.password;
    if(!file) return res.status(400).json({error:'No file uploaded'});
    if(!password) return res.status(400).json({error:'Password required'});
    const inPath = bufferToTempFile(file.buffer,'inpdf');
    const outPath = path.join(os.tmpdir(), `unlocked_${Date.now()}.pdf`);
    try{
      child.execFileSync('qpdf', ['--password='+password, '--decrypt', inPath, outPath], {stdio:'inherit'});
      const buf = fs.readFileSync(outPath);
      fs.unlinkSync(inPath); fs.unlinkSync(outPath);
      res.setHeader('Content-Type','application/pdf');
      res.setHeader('Content-Disposition','attachment; filename=unlocked.pdf');
      res.send(buf);
    }catch(e){
      if(fs.existsSync(inPath)) fs.unlinkSync(inPath);
      if(fs.existsSync(outPath)) fs.unlinkSync(outPath);
      console.error(e);
      res.status(500).json({error:'unlock failed: '+e.message});
    }
  }catch(err){ console.error(err); res.status(500).json({error:err.message}); }
});

// Health
app.get('/health', (req,res) => res.json({status:'ok'}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log('Neunovapdf backend listening on', PORT));
