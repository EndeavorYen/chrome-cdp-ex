import { deflateSync } from 'node:zlib';

export const PDF_PAGE1_LANDMARK = 'AI4AI at Test-Time';
export const PDF_PAGE1_SUBTITLE = 'Strong-to-Weak Capability Transfer via Harnesses';
export const PDF_TJ_TITLE = '[(AI4AI)-250(at)-250(Test-Time:)-250(Strong-to-Weak)-250(Capability)-250(Transfer)-250(via)-250(Harnesses)] TJ';

function pad10(n) {
  return String(n).padStart(10, '0');
}

export function assembleClassicPdf(objects, { root = 1 } = {}) {
  let body = '%PDF-1.4\n%\xbf\xf7\xa2\xfe\n';
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefAt = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index <= objects.length; index += 1) {
    body += `${pad10(offsets[index])} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root ${root} 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

export function pageObjects(contentStream, { filter = null } = {}) {
  let streamObj;
  if (filter === 'FlateDecode') {
    const raw = Buffer.from(contentStream, 'latin1');
    const deflated = deflateSync(raw);
    streamObj = `<< /Length ${deflated.length} /Filter /FlateDecode >>\nstream\n${deflated.toString('latin1')}\nendstream`;
  } else {
    const bytes = Buffer.from(contentStream, 'latin1');
    streamObj = `<< /Length ${bytes.length} >>\nstream\n${contentStream}\nendstream`;
  }
  return [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    streamObj,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
}

export function paidPathPdfBytes() {
  return assembleClassicPdf(pageObjects(`BT /F1 12 Tf 72 720 Td ${PDF_TJ_TITLE} ET`));
}
