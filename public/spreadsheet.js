/* ---------- Spreadsheet import and export: .xlsx and .csv, no libraries ---------- */
const textDecoder = new TextDecoder('utf-8');
const xmlEscape = value => String(value).replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));

/* ----- CSV ----- */
function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const delimiter = [',', ';', '\t'].map(char => [char, firstLine.split(char).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === delimiter) { row.push(cell); cell = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += char;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.map(cells => cells.map(value => value.trim()));
}

/* ----- ZIP reading (enough for .xlsx) ----- */
async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function unzip(buffer) {
  const view = new DataView(buffer), bytes = new Uint8Array(buffer);
  let end = -1;
  for (let i = buffer.byteLength - 22; i >= Math.max(0, buffer.byteLength - 65557); i--) if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error('This is not a valid .xlsx file');
  const count = view.getUint16(end + 10, true);
  let pointer = view.getUint32(end + 16, true);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(pointer, true) !== 0x02014b50) throw new Error('The .xlsx file is damaged');
    const method = view.getUint16(pointer + 10, true), size = view.getUint32(pointer + 20, true);
    const nameLength = view.getUint16(pointer + 28, true), extraLength = view.getUint16(pointer + 30, true), commentLength = view.getUint16(pointer + 32, true);
    const offset = view.getUint32(pointer + 42, true);
    const name = textDecoder.decode(bytes.subarray(pointer + 46, pointer + 46 + nameLength));
    const dataStart = offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true);
    files.set(name, { method, data: bytes.subarray(dataStart, dataStart + size) });
    pointer += 46 + nameLength + extraLength + commentLength;
  }
  return {
    has: name => files.has(name),
    names: () => [...files.keys()],
    async text(name) {
      const file = files.get(name);
      if (!file) return null;
      if (file.method === 0) return textDecoder.decode(file.data);
      if (file.method === 8) return textDecoder.decode(await inflateRaw(file.data));
      throw new Error('Unsupported compression in the .xlsx file');
    }
  };
}

/* ----- XLSX reading ----- */
const parseXml = text => new DOMParser().parseFromString(text, 'application/xml');
const columnIndex = ref => [...ref.replace(/[^A-Z]/gi, '').toUpperCase()].reduce((total, char) => total * 26 + char.charCodeAt(0) - 64, 0) - 1;
async function readXlsx(buffer) {
  const zip = await unzip(buffer);
  let sheetPath = null;
  const workbook = await zip.text('xl/workbook.xml'), rels = await zip.text('xl/_rels/workbook.xml.rels');
  if (workbook && rels) {
    const first = parseXml(workbook).getElementsByTagName('sheet')[0], id = first && (first.getAttribute('r:id') || first.getAttribute('id'));
    const rel = [...parseXml(rels).getElementsByTagName('Relationship')].find(item => item.getAttribute('Id') === id);
    if (rel) { const target = rel.getAttribute('Target'); sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target}`; }
  }
  if (!sheetPath || !zip.has(sheetPath)) sheetPath = zip.names().filter(name => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).sort()[0];
  if (!sheetPath) throw new Error('No worksheet found in this file');
  const shared = [];
  const sharedXml = await zip.text('xl/sharedStrings.xml');
  if (sharedXml) [...parseXml(sharedXml).getElementsByTagName('si')].forEach(item => shared.push([...item.getElementsByTagName('t')].map(node => node.textContent).join('')));
  const rows = [];
  [...parseXml(await zip.text(sheetPath)).getElementsByTagName('row')].forEach(rowNode => {
    const rowIndex = Number(rowNode.getAttribute('r')) - 1;
    const cells = [];
    [...rowNode.getElementsByTagName('c')].forEach((cellNode, position) => {
      const ref = cellNode.getAttribute('r'), index = ref ? columnIndex(ref) : position, type = cellNode.getAttribute('t');
      const valueNode = cellNode.getElementsByTagName('v')[0];
      let value = '';
      if (type === 'inlineStr') value = [...cellNode.getElementsByTagName('t')].map(node => node.textContent).join('');
      else if (valueNode) value = type === 's' ? shared[Number(valueNode.textContent)] ?? '' : valueNode.textContent;
      cells[index] = String(value).trim();
    });
    for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = '';
    rows[Number.isFinite(rowIndex) && rowIndex >= 0 ? rowIndex : rows.length] = cells;
  });
  for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
  return rows;
}

// One entry point for both formats: returns rows of text cells.
async function readSpreadsheet(file) {
  if (file.size > 5 * 1024 * 1024) throw new Error('That file is too large (limit 5 MB)');
  const name = file.name.toLowerCase();
  if (name.endsWith('.csv') || name.endsWith('.txt')) return parseCsv(await file.text());
  if (name.endsWith('.xlsx')) return readXlsx(await file.arrayBuffer());
  if (name.endsWith('.xls')) throw new Error('Old .xls files are not supported. In Excel choose Save As → Excel Workbook (.xlsx) or CSV');
  throw new Error('Choose an Excel (.xlsx) or CSV file');
}

/* ----- XLSX writing (stored, uncompressed zip) ----- */
const crcTable = (() => { const table = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; } return table; })();
const crc32 = bytes => { let c = 0xFFFFFFFF; for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
function zipStore(entries) {
  const encoder = new TextEncoder(), parts = [], central = [];
  let offset = 0;
  const now = new Date(), time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1), date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  entries.forEach(([name, content]) => {
    const nameBytes = encoder.encode(name), data = encoder.encode(content), crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    [[0, 0x04034b50, 4], [4, 20, 2], [6, 0x0800, 2], [8, 0, 2], [10, time, 2], [12, date, 2], [14, crc, 4], [18, data.length, 4], [22, data.length, 4], [26, nameBytes.length, 2], [28, 0, 2]]
      .forEach(([at, value, size]) => size === 4 ? local.setUint32(at, value, true) : local.setUint16(at, value, true));
    const head = new DataView(new ArrayBuffer(46));
    [[0, 0x02014b50, 4], [4, 20, 2], [6, 20, 2], [8, 0x0800, 2], [10, 0, 2], [12, time, 2], [14, date, 2], [16, crc, 4], [20, data.length, 4], [24, data.length, 4], [28, nameBytes.length, 2], [30, 0, 2], [32, 0, 2], [34, 0, 2], [36, 0, 2], [38, 0, 4], [42, offset, 4]]
      .forEach(([at, value, size]) => size === 4 ? head.setUint32(at, value, true) : head.setUint16(at, value, true));
    parts.push(new Uint8Array(local.buffer), nameBytes, data);
    central.push(new Uint8Array(head.buffer), nameBytes);
    offset += 30 + nameBytes.length + data.length;
  });
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true); end.setUint32(12, centralSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
const columnName = index => { let name = ''; for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + (n - 1) % 26) + name; return name; };
function buildXlsx(rows, { widths = [], sheet = 'Sheet1' } = {}) {
  const body = rows.map((row, r) => `<row r="${r + 1}">${row.map((value, c) => {
    const ref = `${columnName(c)}${r + 1}`;
    if (value === '' || value === null || value === undefined) return '';
    return typeof value === 'number' ? `<c r="${ref}"><v>${value}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
  }).join('')}</row>`).join('');
  const cols = widths.length ? `<cols>${widths.map((width, i) => `<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"/>`).join('')}</cols>` : '';
  const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  return zipStore([
    ['[Content_Types].xml', `${head}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`],
    ['_rels/.rels', `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `${head}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlEscape(sheet)}" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`],
    ['xl/worksheets/sheet1.xml', `${head}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols}<sheetData>${body}</sheetData></worksheet>`]
  ]);
}
function saveBlob(blob, filename) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob); link.download = filename;
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}
const downloadXlsx = (filename, rows, options) => saveBlob(buildXlsx(rows, options), filename);
