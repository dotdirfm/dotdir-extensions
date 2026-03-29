import type { ViewerProps } from "@dotdirfm/extension-api";

/**
 * Parse a single line of CSV, handling quoted fields.
 * RFC 4180-style: double quotes escape, "" inside quoted field is literal quote.
 */
function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === '"') {
      let field = "";
      i++;
      while (i < line.length) {
        if (line[i] === '"') {
          i++;
          if (line[i] === '"') {
            field += '"';
            i++;
          } else {
            break;
          }
        } else {
          field += line[i];
          i++;
        }
      }
      result.push(field);
      if (line[i] === ",") i++;
    } else {
      const end = line.indexOf(",", i);
      if (end === -1) {
        result.push(line.slice(i).trim());
        break;
      }
      result.push(line.slice(i, end).trim());
      i = end + 1;
    }
  }
  return result;
}

/** Split text into lines (handles \r\n and \n) and parse each as CSV row. */
function parseCsv(text: string): string[][] {
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  return lines.map((line) => parseCsvLine(line));
}

let rootEl: HTMLElement | null = null;
let keydownHandler: ((e: KeyboardEvent) => void) | null = null;

export async function mountViewer(
  root: HTMLElement,
  props: ViewerProps,
): Promise<void> {
  if (keydownHandler) {
    document.removeEventListener("keydown", keydownHandler);
    keydownHandler = null;
  }

  root.innerHTML = "";
  root.style.margin = "0";
  root.style.padding = "0";
  root.style.width = "100%";
  root.style.height = "100%";
  root.style.display = "flex";
  root.style.flexDirection = "column";
  root.style.overflow = "hidden";
  if (props.inline) {
    root.tabIndex = -1;
  }

  const text = await dotdir.readFileText(props.filePath);
  const rows = parseCsv(text);

  const scrollWrap = document.createElement("div");
  scrollWrap.style.cssText = "flex:1;min-height:0;overflow:auto;padding:8px;";
  rootEl = scrollWrap;
  root.appendChild(scrollWrap);

  const table = document.createElement("table");
  table.style.cssText =
    "border-collapse:collapse;font-family:monospace;font-size:13px;width:max-content;";
  table.setAttribute("role", "grid");

  const thead = document.createElement("thead");
  const tbody = document.createElement("tbody");
  const firstRow = rows[0] ?? [];
  const colCount = Math.max(...rows.map((r) => r.length), 1);

  const addCell = (tr: HTMLTableRowElement, text: string, isHead: boolean) => {
    const cell = document.createElement(isHead ? "th" : "td");
    cell.textContent = text;
    cell.style.cssText =
      "border:1px solid var(--border,#444);padding:4px 8px;text-align:left;white-space:nowrap;";
    if (isHead) {
      cell.style.background = "var(--bg-secondary,#2a2a2a)";
      cell.style.fontWeight = "600";
    }
    tr.appendChild(cell);
  };

  const headerTr = document.createElement("tr");
  for (let c = 0; c < colCount; c++) {
    addCell(headerTr, firstRow[c] ?? `Column ${c + 1}`, true);
  }
  thead.appendChild(headerTr);
  table.appendChild(thead);

  const dataRows = rows.slice(1);
  for (const row of dataRows) {
    const tr = document.createElement("tr");
    for (let c = 0; c < colCount; c++) {
      addCell(tr, row[c] ?? "", false);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  scrollWrap.appendChild(table);

  keydownHandler = (e: KeyboardEvent) => {
    if (e.key === "Escape") dotdir.onClose();
  };
  document.addEventListener("keydown", keydownHandler);
}

export function unmountViewer(): void {
  if (keydownHandler) {
    document.removeEventListener("keydown", keydownHandler);
    keydownHandler = null;
  }
  if (rootEl?.parentNode) {
    rootEl.parentNode.removeChild(rootEl);
  }
  rootEl = null;
}
