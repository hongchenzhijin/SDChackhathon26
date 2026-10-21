// Reads a CV file into plain text, entirely in the browser (the file never leaves the device).
// .txt/.md are read directly; .pdf uses pdf.js, lazy-loaded only when a PDF is chosen.
const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('Could not load PDF reader (offline?) — paste the text instead.'));
    document.head.appendChild(s);
  });
}

async function pdfToText(file) {
  if (!window.pdfjsLib) {
    await loadScript(PDFJS + 'pdf.min.js');
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js';
  }
  const pdf = await window.pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages = [];
  for (let i = 1; i <= Math.min(pdf.numPages, 10); i++) {
    const content = await (await pdf.getPage(i)).getTextContent();
    pages.push(content.items.map(it => it.str).join(' '));
  }
  return pages.join('\n');
}

export async function readCvFile(file) {
  if (file.size > 5 * 1024 * 1024) throw new Error('File is larger than 5 MB.');
  if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') return pdfToText(file);
  return file.text();
}
