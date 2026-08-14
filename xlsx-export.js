const HEADERS = [
  '序号', '信息id', '信息标题', '省份', '城市', '信息类型', '中标时间', '招标方式',
  '项目编号', '招标单位', '中标单位', '代理机构', '信息详情', '网址', '项目预算',
  '资金来源', '中标金额', '评标办法', '业主联系人', '业主联系电话', '中标单位联系人',
  '中标单位联系电话 ', '代理机构联系人', '代理机构联系电话', '详情页正文全文',
  '结构化字段证据', '采集状态', '失败原因', '截止时间', '发布日期'
];

function xml(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function columnName(index) {
  let name = '';
  for (let value = index + 1; value; value = Math.floor((value - 1) / 26)) name = String.fromCharCode(65 + ((value - 1) % 26)) + name;
  return name;
}

function cell(ref, value, style = 0) {
  const text = xml(value);
  return `<c r="${ref}" t="inlineStr" s="${style}"><is><t${/^\s|\s$/.test(String(value ?? '')) ? ' xml:space="preserve"' : ''}>${text}</t></is></c>`;
}

function worksheet(records) {
  const rows = [HEADERS, ...records.map((record, index) => HEADERS.map((header) => header === '序号' ? index + 1 : record[header] ?? ''))];
  const body = rows.map((row, rowIndex) => {
    const style = rowIndex ? 0 : 1;
    return `<row r="${rowIndex + 1}">${row.map((value, index) => cell(`${columnName(index)}${rowIndex + 1}`, value, style)).join('')}</row>`;
  }).join('');
  const widths = HEADERS.map((header, index) => `<col min="${index + 1}" max="${index + 1}" width="${['信息详情', '详情页正文全文', '结构化字段证据'].includes(header) ? 55 : header === '信息标题' ? 40 : 18}" customWidth="1"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols>${widths}</cols><sheetData>${body}</sheetData></worksheet>`;
}

function crc32(bytes) {
  let crc = -1;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
  }
  return (crc ^ -1) >>> 0;
}

function uint16(value) { return [value & 255, (value >>> 8) & 255]; }
function uint32(value) { return [value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255]; }

function zip(files) {
  const encoder = new TextEncoder();
  const chunks = [];
  const entries = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const filename = encoder.encode(name);
    const data = encoder.encode(content);
    const crc = crc32(data);
    const local = new Uint8Array([
      ...uint32(0x04034b50), ...uint16(20), ...uint16(0x0800), ...uint16(0), ...uint16(0), ...uint16(0),
      ...uint32(crc), ...uint32(data.length), ...uint32(data.length), ...uint16(filename.length), ...uint16(0), ...filename, ...data
    ]);
    chunks.push(local);
    entries.push({ name: filename, crc, size: data.length, offset });
    offset += local.length;
  }
  const central = entries.map((entry) => new Uint8Array([
    ...uint32(0x02014b50), ...uint16(20), ...uint16(20), ...uint16(0x0800), ...uint16(0), ...uint16(0), ...uint16(0),
    ...uint32(entry.crc), ...uint32(entry.size), ...uint32(entry.size), ...uint16(entry.name.length), ...uint16(0), ...uint16(0), ...uint16(0), ...uint16(0), ...uint32(0), ...uint32(entry.offset), ...entry.name
  ]));
  const centralSize = central.reduce((size, chunk) => size + chunk.length, 0);
  const end = new Uint8Array([
    ...uint32(0x06054b50), ...uint16(0), ...uint16(0), ...uint16(entries.length), ...uint16(entries.length), ...uint32(centralSize), ...uint32(offset), ...uint16(0)
  ]);
  return new Blob([...chunks, ...central, end], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

export function downloadWorkbook(records) {
  const files = {
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="采集结果" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    'xl/styles.xml': '<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="10"/><name val="Arial"/></font><font><b/><sz val="10"/><name val="Arial"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf xfId="0"/><xf xfId="0" applyFont="1" fontId="1"/></cellXfs></styleSheet>',
    'xl/worksheets/sheet1.xml': worksheet(records)
  };
  const url = URL.createObjectURL(zip(files));
  const link = document.createElement('a');
  link.href = url;
  link.download = `采招网_${new Date().toISOString().slice(0, 10)}.xlsx`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
