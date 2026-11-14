/* Turns dropped files into plain text the assistant can read. Everything is parsed on this
   computer; only the extracted text is ever sent to the model, and only when a message is sent.
   Supported: PDF, Word (.docx), PowerPoint (.pptx), Excel (.xlsx), and text or source-code files. */
(function () {
  'use strict';

  const MAX_BYTES = 30 * 1024 * 1024;
  const MAX_CHARS = 400000;
  const TEXT_EXTENSIONS = /\.(txt|md|csv|tsv|json|xml|ya?ml|ini|log|c|h|cpp|hpp|cc|ino|asm|s|a51|py|js|ts|jsx|tsx|java|cs|go|rs|rb|php|swift|kt|m|sql|sh|bat|ps1|html|css|v|sv|vhd|tex|ipynb)$/i;

  /* ---------- minimal ZIP reader (Office files are ZIP archives of XML) ---------- */
  async function inflate(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  async function unzip(buffer) {
    const view = new DataView(buffer);
    let end = buffer.byteLength - 22;
    while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
    if (end < 0) throw new Error('文件不是有效的 Office 文档');
    const count = view.getUint16(end + 10, true);
    let offset = view.getUint32(end + 16, true);
    const entries = new Map();
    const decoder = new TextDecoder();
    for (let i = 0; i < count; i++) {
      if (view.getUint32(offset, true) !== 0x02014b50) break;
      const method = view.getUint16(offset + 10, true);
      const size = view.getUint32(offset + 20, true);
      const nameLength = view.getUint16(offset + 28, true);
      const extraLength = view.getUint16(offset + 30, true);
      const commentLength = view.getUint16(offset + 32, true);
      const local = view.getUint32(offset + 42, true);
      const name = decoder.decode(new Uint8Array(buffer, offset + 46, nameLength));
      entries.set(name, { method, size, local });
      offset += 46 + nameLength + extraLength + commentLength;
    }
    return {
      names: [...entries.keys()],
      async text(name) {
        const entry = entries.get(name);
        if (!entry) return '';
        const start = entry.local + 30 + view.getUint16(entry.local + 26, true) + view.getUint16(entry.local + 28, true);
        const raw = new Uint8Array(buffer, start, entry.size);
        return decoder.decode(entry.method === 0 ? raw : await inflate(raw));
      },
    };
  }
  const xml = (text) => new DOMParser().parseFromString(text, 'application/xml');
  const byNumber = (pattern) => (a, b) => Number(a.match(pattern)[1]) - Number(b.match(pattern)[1]);
  const tagText = (node, tag) => [...node.getElementsByTagName(tag)].map((x) => x.textContent).join('');

  async function readDocx(buffer) {
    const zip = await unzip(buffer);
    const doc = xml(await zip.text('word/document.xml'));
    return [...doc.getElementsByTagName('w:p')].map((p) => tagText(p, 'w:t')).filter(Boolean).join('\n');
  }
  async function readPptx(buffer) {
    const zip = await unzip(buffer);
    const pattern = /^ppt\/slides\/slide(\d+)\.xml$/;
    const slides = zip.names.filter((n) => pattern.test(n)).sort(byNumber(pattern));
    const parts = [];
    for (let i = 0; i < slides.length; i++) {
      const doc = xml(await zip.text(slides[i]));
      const lines = [...doc.getElementsByTagName('a:p')].map((p) => tagText(p, 'a:t')).filter(Boolean);
      parts.push('[第 ' + (i + 1) + ' 页]\n' + lines.join('\n'));
    }
    return { text: parts.join('\n\n'), units: slides.length + ' 页' };
  }
  async function readXlsx(buffer) {
    const zip = await unzip(buffer);
    const shared = [...xml(await zip.text('xl/sharedStrings.xml')).getElementsByTagName('si')].map((si) => tagText(si, 't'));
    const pattern = /^xl\/worksheets\/sheet(\d+)\.xml$/;
    const sheets = zip.names.filter((n) => pattern.test(n)).sort(byNumber(pattern));
    const parts = [];
    for (let i = 0; i < sheets.length; i++) {
      const rows = [...xml(await zip.text(sheets[i])).getElementsByTagName('row')].slice(0, 500).map((row) =>
        [...row.getElementsByTagName('c')].map((cell) => {
          const value = tagText(cell, 'v');
          if (cell.getAttribute('t') === 's') return shared[Number(value)] || '';
          return cell.getAttribute('t') === 'inlineStr' ? tagText(cell, 't') : value;
        }).join('\t'));
      parts.push('[工作表 ' + (i + 1) + ']\n' + rows.join('\n'));
    }
    return { text: parts.join('\n\n'), units: sheets.length + ' 个工作表' };
  }

  /* ---------- PDF (pdf.js, loaded only when the first PDF arrives) ---------- */
  let pdfReady;
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = src;
      el.onload = resolve;
      el.onerror = () => reject(new Error('无法加载 PDF 组件'));
      document.head.append(el);
    });
  }
  async function readPdf(buffer) {
    // Loading the worker script on the page lets pdf.js run without a separate worker file request.
    pdfReady = pdfReady || loadScript('vendor/pdfjs/pdf.min.js').then(() => loadScript('vendor/pdfjs/pdf.worker.min.js'));
    await pdfReady;
    const pdf = await window.pdfjsLib.getDocument({ data: buffer, isEvalSupported: false }).promise;
    const parts = [];
    let total = 0;
    for (let n = 1; n <= pdf.numPages && total < MAX_CHARS; n++) {
      const content = await (await pdf.getPage(n)).getTextContent();
      let line = '';
      for (const item of content.items) line += item.str + (item.hasEOL ? '\n' : '');
      total += line.length;
      parts.push('[第 ' + n + ' 页]\n' + line.trim());
    }
    return { text: parts.join('\n\n'), units: pdf.numPages + ' 页' };
  }

  /* ---------- images ----------
     Large photos are scaled down before sending: it keeps requests small and is enough for reading handwriting. */
  const IMAGE_TYPES = /^image\/(png|jpeg|webp|gif|bmp)$/;
  const MAX_SIDE = 1568;
  function draw(bitmap, maxSide, quality) {
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return { url: canvas.toDataURL('image/jpeg', quality), width: canvas.width, height: canvas.height };
  }
  async function readImage(file) {
    let bitmap;
    try { bitmap = await createImageBitmap(file); } catch { throw new Error('这张图片打不开'); }
    const full = draw(bitmap, MAX_SIDE, 0.86);
    const thumb = draw(bitmap, 160, 0.7);
    return {
      name: file.name || '图片.jpg', kind: '图片', units: full.width + '×' + full.height, text: '',
      image: { mediaType: 'image/jpeg', data: full.url.split(',')[1] }, thumb: thumb.url,
    };
  }

  /* Returns { name, kind, text, units } (plus image and thumb for pictures). Throws a readable message for unsupported files. */
  async function parseFile(file) {
    if (file.size > MAX_BYTES) throw new Error('文件超过 30 MB');
    if (IMAGE_TYPES.test(file.type) || /\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name)) return readImage(file);
    const name = file.name;
    const ext = (name.match(/\.([^.]+)$/) || ['', ''])[1].toLowerCase();
    let result;
    if (ext === 'pdf') result = { kind: 'PDF', ...(await readPdf(await file.arrayBuffer())) };
    else if (ext === 'docx') result = { kind: 'Word', text: await readDocx(await file.arrayBuffer()) };
    else if (ext === 'pptx') result = { kind: 'PPT', ...(await readPptx(await file.arrayBuffer())) };
    else if (ext === 'xlsx') result = { kind: 'Excel', ...(await readXlsx(await file.arrayBuffer())) };
    else if (['doc', 'ppt', 'xls'].includes(ext)) throw new Error('旧格式 .' + ext + ' 读不了，请在 Office 或 WPS 里另存为 .' + ext + 'x');
    else if (TEXT_EXTENSIONS.test(name) || file.type.startsWith('text/')) result = { kind: '文本', text: await file.text() };
    else throw new Error('不支持这种文件（支持图片、PDF、Word、PPT、Excel、文本和代码）');
    const text = result.text.replace(/\u0000/g, '').slice(0, MAX_CHARS);
    if (!text.trim()) throw new Error('没有读到文字（可能是扫描件或图片）');
    return { name, kind: result.kind, units: result.units || text.length + ' 字', text };
  }

  window.TPlanFiles = { parseFile };
})();
