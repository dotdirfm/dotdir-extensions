import type { ViewerProps } from '@dotdirfm/extension-api';

// ---- DS_Store Binary Parser ----
// Format reference: https://metacpan.org/dist/Mac-Finder-DSStore/view/DSStoreFormat.pod
//
// Structure:
//   [0-3]   file magic: 00 00 00 01
//   [4-35]  buddy allocator header:
//             [4-7]  "Bud1"
//             [8-11] offset to bookkeeping block (relative to byte 4)
//             [12-15] size of bookkeeping block
//             [16-19] duplicate offset
//   [36+]   buddy allocator address space (all offsets relative to byte 4)
//
// Block address encoding: addr & ~0x1F = file_offset - 4, addr & 0x1F = size exponent (size = 1 << n)
// Bookkeeping block: block_count, unknown, block_addr_array[256], dir_count, dir_entries[], freelists[]
// B-tree located via "DSDB" directory entry, 20-byte header: root, levels, records, nodes, page_size

type DSRecord = {
  filename: string;
  structId: string;
  dataType: string;
  value: number | bigint | boolean | string | Uint8Array | null;
};

class DSStoreParser {
  private view: DataView;
  private data: Uint8Array;
  // All block addresses are stored relative to byte 4 (the buddy allocator base)
  private static readonly BASE = 4;
  private blocks: Array<{ offset: number; size: number }> = [];

  constructor(buffer: ArrayBuffer) {
    this.data = new Uint8Array(buffer);
    this.view = new DataView(buffer);
  }

  private u32(offset: number): number {
    return this.view.getUint32(offset, false); // big-endian
  }

  private u64(offset: number): bigint {
    return this.view.getBigUint64(offset, false);
  }

  private fcc(offset: number): string {
    return String.fromCharCode(
      this.data[offset],
      this.data[offset + 1],
      this.data[offset + 2],
      this.data[offset + 3],
    );
  }

  private utf16be(offset: number, charCount: number): string {
    const bytes = this.data.slice(offset, offset + charCount * 2);
    let s = '';
    for (let i = 0; i < bytes.length - 1; i += 2) {
      s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    }
    return s;
  }

  parse(): DSRecord[] {
    // Validate magic
    if (this.u32(0) !== 0x00000001) throw new Error('Invalid file magic');
    if (this.fcc(4) !== 'Bud1') throw new Error('Invalid buddy allocator magic');

    const bkRelOffset = this.u32(8);
    const bkOffset = DSStoreParser.BASE + bkRelOffset;

    const blockCount = this.u32(bkOffset);
    if (blockCount === 0 || blockCount > 256) throw new Error(`Invalid block count: ${blockCount}`);

    // Parse block address array
    for (let i = 0; i < blockCount; i++) {
      const addr = this.u32(bkOffset + 8 + i * 4);
      // offset is relative to BASE, not absolute
      const fileOffset = DSStoreParser.BASE + (addr & 0xfffffff0 & ~0x0000001f);
      const size = 1 << (addr & 0x1f);
      this.blocks.push({ offset: fileOffset, size });
    }

    // Find DSDB directory entry (after 256-entry block array)
    const dirSectionOffset = bkOffset + 8 + 256 * 4;
    const dirCount = this.u32(dirSectionOffset);
    let pos = dirSectionOffset + 4;
    let btreeBlockNum = -1;

    for (let d = 0; d < dirCount; d++) {
      const nameLen = this.data[pos];
      const name = String.fromCharCode(...this.data.slice(pos + 1, pos + 1 + nameLen));
      const blockNum = this.u32(pos + 1 + nameLen);
      pos += 1 + nameLen + 4;
      if (name === 'DSDB') {
        btreeBlockNum = blockNum;
        break;
      }
    }

    if (btreeBlockNum < 0) throw new Error('DSDB directory entry not found');

    // B-tree header (20 bytes)
    const btreeHdr = this.blocks[btreeBlockNum].offset;
    const rootBlockNum = this.u32(btreeHdr);

    // Traverse B-tree
    const records: DSRecord[] = [];
    this.parseNode(rootBlockNum, records);
    return records;
  }

  private parseNode(blockNum: number, records: DSRecord[]): void {
    if (blockNum >= this.blocks.length) return;
    const { offset } = this.blocks[blockNum];
    const P = this.u32(offset);       // 0 = leaf, otherwise = rightmost child
    const count = this.u32(offset + 4);
    let pos = offset + 8;

    if (P === 0) {
      // Leaf node: just records
      for (let i = 0; i < count; i++) {
        const result = this.parseRecord(pos);
        records.push(result.record);
        pos = result.nextPos;
      }
    } else {
      // Internal node: child, record, child, record, ..., P (rightmost child)
      for (let i = 0; i < count; i++) {
        const childBlock = this.u32(pos);
        pos += 4;
        this.parseNode(childBlock, records);
        const result = this.parseRecord(pos);
        records.push(result.record);
        pos = result.nextPos;
      }
      this.parseNode(P, records);
    }
  }

  private parseRecord(pos: number): { record: DSRecord; nextPos: number } {
    const fnameLen = this.u32(pos);
    pos += 4;
    const filename = this.utf16be(pos, fnameLen);
    pos += fnameLen * 2;

    const structId = this.fcc(pos);
    pos += 4;
    const dataType = this.fcc(pos);
    pos += 4;

    let value: DSRecord['value'] = null;

    switch (dataType) {
      case 'long': {
        value = this.u32(pos);
        pos += 4;
        break;
      }
      case 'shor': {
        value = this.u32(pos) & 0xffff;
        pos += 4;
        break;
      }
      case 'bool': {
        value = this.data[pos] !== 0;
        pos += 1;
        break;
      }
      case 'blob': {
        const len = this.u32(pos);
        pos += 4;
        value = this.data.slice(pos, pos + len);
        pos += len;
        break;
      }
      case 'type': {
        value = this.fcc(pos);
        pos += 4;
        break;
      }
      case 'ustr': {
        const charCount = this.u32(pos);
        pos += 4;
        value = this.utf16be(pos, charCount);
        pos += charCount * 2;
        break;
      }
      case 'comp': {
        value = this.view.getBigInt64(pos, false);
        pos += 8;
        break;
      }
      case 'dutc': {
        value = this.view.getBigUint64(pos, false);
        pos += 8;
        break;
      }
      default: {
        // Unknown type: skip 4 bytes
        pos += 4;
      }
    }

    return { record: { filename, structId, dataType, value }, nextPos: pos };
  }
}

// ---- Value Formatting ----

// Mac absolute time epoch: seconds since Jan 1, 2001 00:00:00 UTC
const MAC_EPOCH_MS = Date.UTC(2001, 0, 1);
// Mac HFS+ timestamp epoch: seconds since Jan 1, 1904 00:00:00 UTC
const MAC_HFS_EPOCH_MS = Date.UTC(1904, 0, 1);

function formatDate(epochMs: number, seconds: number): string {
  const ts = epochMs + seconds * 1000;
  if (ts < 0 || ts > 9999999999999) return `<invalid date>`;
  return new Date(ts).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

function formatBytes(bytes: bigint | number): string {
  const n = typeof bytes === 'bigint' ? Number(bytes) : bytes;
  if (n === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exp = Math.min(Math.floor(Math.log2(n) / 10), units.length - 1);
  const val = n / Math.pow(1024, exp);
  return `${val % 1 === 0 ? val : val.toFixed(1)} ${units[exp]}`;
}

const STRUCT_LABELS: Record<string, string> = {
  Iloc: 'Icon Position',
  bwsp: 'Browser Window',
  icvp: 'Icon View Options',
  lsvp: 'List View Options',
  lsvC: 'List View Columns',
  lsvo: 'List View Options',
  icvo: 'Icon View Options',
  vSrn: 'Version',
  vstl: 'View Style',
  modD: 'Modification Date',
  moDD: 'Modification Date',
  pBBk: 'File Bookmark',
  cmmt: 'Spotlight Comment',
  extn: 'Extension',
  logS: 'Logical Size',
  lg1S: 'Logical Size',
  phys: 'Physical Size',
  ph1S: 'Physical Size',
  BKGD: 'Background',
  fwi0: 'Window Frame',
  pict: 'Background Image',
  dscl: 'Disclosure State',
  glvp: 'Gallery View Options',
};

const VIEW_STYLE_NAMES: Record<string, string> = {
  icnv: 'Icon View',
  clmv: 'Column View',
  Nlsv: 'List View',
  Flwv: 'Gallery View',
  glyv: 'Gallery View',
};

function formatValue(record: DSRecord): { text: string; tag: string } {
  const { structId, dataType, value } = record;

  // Blob types: decode known ones
  if (dataType === 'blob' && value instanceof Uint8Array) {
    const blob = value;

    // Modification date: 8-byte little-endian double, seconds since Mac absolute time (2001-01-01)
    if ((structId === 'modD' || structId === 'moDD') && blob.length === 8) {
      const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
      const secs = dv.getFloat64(0, true); // little-endian
      if (secs > 0 && secs < 1e12) {
        return { text: formatDate(MAC_EPOCH_MS, secs), tag: 'date' };
      }
    }

    // Icon location: 16 bytes, big-endian int32 x, y, then 8 bytes (often -1 = auto)
    if (structId === 'Iloc' && blob.length === 16) {
      const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
      const x = dv.getInt32(0, false);
      const y = dv.getInt32(4, false);
      const isAuto = blob.slice(8).every((b) => b === 0xff);
      const pos = `x=${x}, y=${y}`;
      return { text: isAuto ? `${pos} (auto)` : pos, tag: 'position' };
    }

    // Binary plist
    if (blob.length >= 6 && String.fromCharCode(...blob.slice(0, 6)) === 'bplist') {
      const plistVersion = String.fromCharCode(blob[6], blob[7]);
      return { text: `binary plist ${plistVersion} (${blob.length} bytes)`, tag: 'blob' };
    }

    // Generic blob
    const hex = Array.from(blob.slice(0, 16))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(' ');
    return {
      text: blob.length > 16 ? `${hex}… (${blob.length} bytes)` : hex,
      tag: 'blob',
    };
  }

  // File sizes (logical / physical)
  if ((structId === 'lg1S' || structId === 'ph1S' || structId === 'logS' || structId === 'phys') &&
      (dataType === 'comp' || dataType === 'long') && value !== null) {
    const n = typeof value === 'bigint' ? value : BigInt(value as number);
    return { text: `${formatBytes(n)} (${n.toLocaleString()} bytes)`, tag: 'size' };
  }

  // dutc timestamp (1/65536-second intervals since 1904-01-01)
  if (dataType === 'dutc' && typeof value === 'bigint') {
    const secs = Number(value) / 65536;
    return { text: formatDate(MAC_HFS_EPOCH_MS, secs), tag: 'date' };
  }

  // View style
  if (structId === 'vstl' && dataType === 'type' && typeof value === 'string') {
    return { text: VIEW_STYLE_NAMES[value] ?? value, tag: 'type' };
  }

  if (typeof value === 'boolean') return { text: value ? 'true' : 'false', tag: 'bool' };
  if (typeof value === 'bigint') return { text: value.toString(), tag: 'number' };
  if (typeof value === 'number') return { text: value.toString(), tag: 'number' };
  if (typeof value === 'string') return { text: value, tag: 'string' };

  return { text: '<null>', tag: 'null' };
}

// ---- Rendering ----

const TAG_COLORS: Record<string, string> = {
  date: '#7ec8a4',
  position: '#79b8ff',
  size: '#e8c06e',
  blob: '#888',
  bool: '#e06c75',
  number: '#d19a66',
  string: '#98c379',
  type: '#c678dd',
  null: '#555',
};

let rootEl: HTMLElement | null = null;
let keydownHandler: ((e: KeyboardEvent) => void) | null = null;

export async function mountViewer(root: HTMLElement, props: ViewerProps): Promise<void> {
  if (keydownHandler) {
    document.removeEventListener('keydown', keydownHandler);
    keydownHandler = null;
  }

  root.innerHTML = '';
  Object.assign(root.style, {
    margin: '0', padding: '0', width: '100%', height: '100%',
    display: 'flex', flexDirection: 'column', overflow: 'hidden',
    fontFamily: 'monospace', fontSize: '13px',
    background: 'var(--bg, #1e1e1e)', color: 'var(--fg, #ccc)',
  });

  if (props.inline) root.tabIndex = -1;

  // Parse the file
  let records: DSRecord[];
  try {
    const buffer = await dotdir.readFile(props.filePath);
    const parser = new DSStoreParser(buffer);
    records = parser.parse();
  } catch (err) {
    const msg = document.createElement('div');
    msg.textContent = `Error parsing .DS_Store: ${err instanceof Error ? err.message : String(err)}`;
    msg.style.cssText = 'padding:16px;color:#e06c75;';
    root.appendChild(msg);
    return;
  }

  // Group records by filename
  const byFile = new Map<string, DSRecord[]>();
  for (const rec of records) {
    const group = byFile.get(rec.filename) ?? [];
    group.push(rec);
    byFile.set(rec.filename, group);
  }

  // Header bar
  const header = document.createElement('div');
  header.style.cssText = 'padding:8px 12px;border-bottom:1px solid var(--border,#333);flex-shrink:0;display:flex;gap:16px;align-items:center;';
  const title = document.createElement('span');
  title.textContent = '.DS_Store';
  title.style.cssText = 'font-weight:600;font-size:14px;color:var(--fg,#ccc);';
  const stats = document.createElement('span');
  stats.textContent = `${records.length} records · ${byFile.size} items`;
  stats.style.cssText = 'color:#888;font-size:12px;';
  header.appendChild(title);
  header.appendChild(stats);
  root.appendChild(header);

  // Scroll container
  const scroll = document.createElement('div');
  scroll.style.cssText = 'flex:1;min-height:0;overflow:auto;';
  rootEl = scroll;
  root.appendChild(scroll);

  // Table
  const table = document.createElement('table');
  table.style.cssText = 'border-collapse:collapse;width:100%;table-layout:fixed;';

  // Column widths
  const colgroup = document.createElement('colgroup');
  for (const w of ['35%', '20%', '10%', '35%']) {
    const col = document.createElement('col');
    col.style.width = w;
    colgroup.appendChild(col);
  }
  table.appendChild(colgroup);

  // Column headers
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  headRow.style.cssText = 'position:sticky;top:0;z-index:1;';
  for (const label of ['Filename', 'Attribute', 'Type', 'Value']) {
    const th = document.createElement('th');
    th.textContent = label;
    th.style.cssText = `
      background:var(--bg-secondary,#252525);
      border-bottom:1px solid var(--border,#333);
      padding:6px 10px;text-align:left;font-weight:600;
      color:var(--fg,#ccc);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
    `;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');

  // Sort filenames: special entry '.' (directory itself) first, then alphabetically
  const filenames = [...byFile.keys()].sort((a, b) => {
    if (a === '.') return -1;
    if (b === '.') return 1;
    return a.localeCompare(b, undefined, { sensitivity: 'base' });
  });

  let rowIndex = 0;
  for (const filename of filenames) {
    const fileRecords = byFile.get(filename)!;
    const isEven = rowIndex % 2 === 0;
    rowIndex++;

    // Sort records within a file by structId
    fileRecords.sort((a, b) => a.structId.localeCompare(b.structId));

    for (let i = 0; i < fileRecords.length; i++) {
      const rec = fileRecords[i];
      const tr = document.createElement('tr');
      const rowBg = isEven ? 'var(--bg,#1e1e1e)' : 'var(--bg-alt,#222)';
      tr.style.background = rowBg;

      // Filename cell (only for first record in group)
      if (i === 0) {
        const td = document.createElement('td');
        td.rowSpan = fileRecords.length;
        td.textContent = filename;
        td.title = filename;
        td.style.cssText = `
          padding:5px 10px;vertical-align:top;
          border-right:1px solid var(--border,#333);
          border-bottom:1px solid var(--border,#333);
          white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
          color:${filename.startsWith('.') || filename === '.' ? '#79b8ff' : 'var(--fg,#ccc)'};
          font-weight:500;
        `;
        tr.appendChild(td);
      }

      // Attribute cell
      const attrTd = document.createElement('td');
      const label = STRUCT_LABELS[rec.structId];
      attrTd.style.cssText = `
        padding:5px 10px;border-bottom:1px solid var(--border,#2a2a2a);
        white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
      `;
      attrTd.title = rec.structId;
      if (label) {
        const labelSpan = document.createElement('span');
        labelSpan.textContent = label;
        const codeSpan = document.createElement('span');
        codeSpan.textContent = ` (${rec.structId})`;
        codeSpan.style.color = '#555';
        codeSpan.style.fontSize = '11px';
        attrTd.appendChild(labelSpan);
        attrTd.appendChild(codeSpan);
      } else {
        attrTd.textContent = rec.structId;
        attrTd.style.color = '#aaa';
      }
      tr.appendChild(attrTd);

      // Type cell
      const typeTd = document.createElement('td');
      typeTd.textContent = rec.dataType;
      typeTd.style.cssText = `
        padding:5px 10px;border-bottom:1px solid var(--border,#2a2a2a);
        color:#666;white-space:nowrap;
      `;
      tr.appendChild(typeTd);

      // Value cell
      const { text, tag } = formatValue(rec);
      const valTd = document.createElement('td');
      valTd.textContent = text;
      valTd.title = text;
      valTd.style.cssText = `
        padding:5px 10px;border-bottom:1px solid var(--border,#2a2a2a);
        overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
        color:${TAG_COLORS[tag] ?? 'var(--fg,#ccc)'};
      `;
      tr.appendChild(valTd);

      tbody.appendChild(tr);
    }
  }

  table.appendChild(tbody);
  scroll.appendChild(table);

  keydownHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') dotdir.onClose();
  };
  document.addEventListener('keydown', keydownHandler);
}

export function unmountViewer(): void {
  if (keydownHandler) {
    document.removeEventListener('keydown', keydownHandler);
    keydownHandler = null;
  }
  if (rootEl?.parentNode) rootEl.parentNode.removeChild(rootEl);
  rootEl = null;
}
