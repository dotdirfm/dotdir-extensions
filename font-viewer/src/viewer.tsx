import React, { useEffect, useMemo, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import opentype, { type Font } from 'opentype.js';
import type { HostApi, ViewerProps } from './types';

type ScriptId =
  | 'latin'
  | 'cyrillic'
  | 'greek'
  | 'hebrew'
  | 'arabic'
  | 'devanagari'
  | 'thai'
  | 'hiragana_katakana'
  | 'hangul';

type Sample = {
  id: ScriptId;
  label: string;
  text: string;
};

const SCRIPT_TESTS: Array<{ id: ScriptId; label: string; codepoints: number[] }> = [
  { id: 'latin', label: 'Latin', codepoints: [0x0041, 0x0061, 0x005a, 0x007a] },
  { id: 'cyrillic', label: 'Cyrillic', codepoints: [0x0410, 0x0430, 0x042f, 0x044f, 0x0401, 0x0451] }, // А а Я я Ё ё
  { id: 'greek', label: 'Greek', codepoints: [0x0391, 0x03b1, 0x03a9, 0x03c9] }, // Α α Ω ω
  { id: 'hebrew', label: 'Hebrew', codepoints: [0x05d0, 0x05ea] }, // א ת
  { id: 'arabic', label: 'Arabic', codepoints: [0x0627, 0x064a] }, // ا ي
  { id: 'devanagari', label: 'Devanagari', codepoints: [0x0905, 0x0939] }, // अ ह
  { id: 'thai', label: 'Thai', codepoints: [0x0e01, 0x0e2e] }, // ก ฮ
  { id: 'hiragana_katakana', label: 'Japanese (Kana)', codepoints: [0x3042, 0x3093, 0x30a2, 0x30f3] }, // あ ん ア ン
  { id: 'hangul', label: 'Korean (Hangul)', codepoints: [0xac00, 0xd55c] }, // 가 한
];

const SAMPLES: Sample[] = [
  { id: 'latin', label: 'English pangram', text: 'Sphinx of black quartz, judge my vow.' },
  { id: 'latin', label: 'English (all letters)', text: 'The quick brown fox jumps over the lazy dog.' },
  { id: 'cyrillic', label: 'Russian pangram', text: 'Съешь же ещё этих мягких французских булок, да выпей чаю.' },
  { id: 'greek', label: 'Greek pangram', text: 'Ξεσκεπάζω την ψυχοφθόρα βδελυγμία.' },
  { id: 'hebrew', label: 'Hebrew sample', text: 'דג סקרן שט בים מאוכזב ולפתע מצא לו חברה איך הקליטה.' },
  { id: 'arabic', label: 'Arabic sample', text: 'صِفْ خَلْفَ نَجْدٍ شَجَرًا يَزْهُو بِحُسْنٍ.' },
  { id: 'devanagari', label: 'Hindi sample', text: 'प्यारे बच्चे जल्दी उठकर खूब पढ़ाई करें।' },
  { id: 'thai', label: 'Thai sample', text: 'เป็นมนุษย์สุดประเสริฐเลิศคุณค่า' },
  { id: 'hiragana_katakana', label: 'Japanese sample', text: 'いろはにほへと ちりぬるを / イロハニホヘト チリヌルヲ' },
  { id: 'hangul', label: 'Korean sample', text: '키스의 고유조건은 입술끼리 만나야 하고 특별한 기술은 필요치 않다.' },
];

function randomFamilyName(fileName: string): string {
  const rand = Math.random().toString(36).slice(2);
  const safe = fileName.replace(/[^a-z0-9_-]+/gi, '-').slice(0, 32);
  return `FaradayFont-${safe}-${rand}`;
}

function formatBytes(bytes: number): string {
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(2)} MB`;
}

function tryParseOpenType(buffer: ArrayBuffer): { font?: Font; error?: string } {
  try {
    const font = opentype.parse(buffer);
    return { font };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: msg };
  }
}

function getGlyphCodepointSet(font: Font): Set<number> {
  const cmap = (font as unknown as { tables?: { cmap?: { glyphIndexMap?: Record<string, number> } } }).tables?.cmap?.glyphIndexMap;
  const set = new Set<number>();
  if (!cmap) return set;
  for (const k of Object.keys(cmap)) {
    const cp = Number(k);
    if (!Number.isNaN(cp)) set.add(cp);
  }
  return set;
}

function detectScriptsFromFont(font?: Font): Array<{ id: ScriptId; label: string; confidence: 'high' | 'medium' }> {
  if (!font) return [];
  const cps = getGlyphCodepointSet(font);
  if (cps.size === 0) return [];

  const supported: Array<{ id: ScriptId; label: string; confidence: 'high' | 'medium' }> = [];
  for (const s of SCRIPT_TESTS) {
    const hits = s.codepoints.reduce((acc, cp) => acc + (cps.has(cp) ? 1 : 0), 0);
    if (hits === 0) continue;
    supported.push({ id: s.id, label: s.label, confidence: hits === s.codepoints.length ? 'high' : 'medium' });
  }
  return supported;
}

function pickSamplesForScripts(scripts: Array<{ id: ScriptId }>): Sample[] {
  const ids = new Set(scripts.map((s) => s.id));
  const picked = SAMPLES.filter((s) => ids.has(s.id));
  if (picked.length > 0) return picked;
  return [
    { id: 'latin', label: 'Fallback', text: 'The quick brown fox jumps over the lazy dog.' },
    { id: 'latin', label: 'Symbols', text: '0123456789 !@#$%^&*() []{} <>=+-_— “quotes” ‘apostrophes’' },
  ];
}

function App(props: { hostApi: HostApi; viewerProps: ViewerProps }) {
  const { hostApi, viewerProps } = props;
  const [family, setFamily] = useState(() => randomFamilyName(viewerProps.fileName));
  const [fontFaceStatus, setFontFaceStatus] = useState<'loading' | 'loaded' | 'error'>('loading');
  const [fontFaceError, setFontFaceError] = useState<string | null>(null);
  const [font, setFont] = useState<Font | undefined>(undefined);
  const [parseError, setParseError] = useState<string | null>(null);
  const [baseText, setBaseText] = useState('The quick brown fox jumps over the lazy dog.');

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    (async () => {
      setFontFaceStatus('loading');
      setFontFaceError(null);
      setParseError(null);
      setFont(undefined);

      const buffer = await hostApi.readFile(viewerProps.filePath);
      if (cancelled) return;

      // Register font for preview (works for ttf/otf/woff/woff2 in modern browsers).
      try {
        const face = new FontFace(family, buffer);
        await face.load();
        if (cancelled) return;
        document.fonts.add(face);
        setFontFaceStatus('loaded');
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setFontFaceStatus('error');
        setFontFaceError(msg);
      }

      // Parse for unicode/script detection (opentype.js may not support woff2/collections reliably).
      const parsed = tryParseOpenType(buffer);
      if (cancelled) return;
      if (parsed.font) {
        setFont(parsed.font);
      } else {
        setParseError(parsed.error ?? 'Unable to parse font.');
      }
    })().catch((e) => {
      if (cancelled) return;
      const msg = e instanceof Error ? e.message : String(e);
      setFontFaceStatus('error');
      setFontFaceError(msg);
    });

    return () => {
      cancelled = true;
      controller.abort();
      // We intentionally do not remove the FontFace from document.fonts: the API is not consistently removable across browsers.
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewerProps.filePath, family]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hostApi.onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [hostApi]);

  const scripts = useMemo(() => detectScriptsFromFont(font), [font]);
  const samples = useMemo(() => pickSamplesForScripts(scripts), [scripts]);
  const meta = useMemo(() => {
    if (!font) return null;
    const names = (font as unknown as { names?: Record<string, Record<string, string>> }).names ?? {};
    const pick = (key: string) => {
      const entry = names[key];
      if (!entry) return undefined;
      return entry.en ?? entry['en-US'] ?? Object.values(entry)[0];
    };
    return {
      family: pick('fontFamily') ?? pick('preferredFamily'),
      subfamily: pick('fontSubfamily') ?? pick('preferredSubfamily'),
      fullName: pick('fullName'),
      postScriptName: pick('postScriptName'),
      numGlyphs: (font as unknown as { numGlyphs?: number }).numGlyphs,
      unitsPerEm: (font as unknown as { unitsPerEm?: number }).unitsPerEm,
    };
  }, [font]);

  const containerStyle: React.CSSProperties = {
    width: '100%',
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif',
    color: 'var(--fg)',
    background: 'var(--bg)',
  };

  const panelStyle: React.CSSProperties = {
    flex: 1,
    minHeight: 0,
    overflow: 'auto',
    padding: 12,
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  };

  const cardStyle: React.CSSProperties = {
    border: '1px solid var(--border)',
    borderRadius: 10,
    background: 'var(--bg-secondary)',
    padding: 12,
  };

  const chipStyle: React.CSSProperties = {
    display: 'inline-flex',
    gap: 6,
    alignItems: 'center',
    padding: '2px 8px',
    borderRadius: 999,
    border: '1px solid var(--border)',
    background: 'var(--accent)',
    fontSize: 12,
    color: 'var(--accent-fg)',
  };

  const previewRows = [
    { label: 'Thin', weight: 200, italic: false },
    { label: 'Regular', weight: 400, italic: false },
    { label: 'Regular Italic', weight: 400, italic: true },
    { label: 'Semibold', weight: 600, italic: false },
    { label: 'Bold', weight: 700, italic: false },
    { label: 'Bold Italic', weight: 700, italic: true },
  ] as const;

  return (
    <div style={containerStyle}>
      <div
        style={{
          padding: '10px 12px',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 650, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {viewerProps.fileName}
          </div>
          <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
            {formatBytes(viewerProps.fileSize)}
            {meta?.fullName ? ` · ${meta.fullName}` : ''}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <span style={chipStyle}>
            <span style={{ opacity: 0.8 }}>FontFace</span>
            <strong style={{ fontWeight: 650 }}>
              {fontFaceStatus === 'loaded' ? 'loaded' : fontFaceStatus === 'loading' ? 'loading' : 'error'}
            </strong>
          </span>
          <span style={chipStyle}>
            <span style={{ opacity: 0.8 }}>Scripts</span>
            <strong style={{ fontWeight: 650 }}>{scripts.length}</strong>
          </span>
        </div>
      </div>

      <div style={panelStyle}>
        {(fontFaceStatus === 'error' || parseError) && (
          <div style={{ ...cardStyle, borderColor: 'var(--error-fg)', background: 'var(--error-bg)', color: 'var(--error-fg)' }}>
            <div style={{ fontWeight: 650, marginBottom: 6 }}>Some capabilities are limited for this font</div>
            {fontFaceError && (
              <div style={{ fontSize: 12, opacity: 0.9, marginBottom: 6 }}>
                <strong>Preview load:</strong> {fontFaceError}
              </div>
            )}
            {parseError && (
              <div style={{ fontSize: 12, opacity: 0.9 }}>
                <strong>Coverage detect:</strong> {parseError}
              </div>
            )}
            <div style={{ fontSize: 12, opacity: 0.75, marginTop: 8 }}>
              If this is a WOFF2 or font collection, preview may still work even when coverage detection can’t parse it.
            </div>
          </div>
        )}

        <div style={cardStyle}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ fontSize: 13, fontWeight: 650 }}>Base text</div>
            <input
              value={baseText}
              onChange={(e) => setBaseText(e.target.value)}
              style={{
                flex: 1,
                minWidth: 240,
                padding: '8px 10px',
                borderRadius: 8,
                border: '1px solid var(--border)',
                background: 'var(--bg)',
                color: 'var(--fg)',
                outline: 'none',
              }}
              spellCheck={false}
            />
            <button
              onClick={() => setFamily(randomFamilyName(viewerProps.fileName))}
              style={{
                padding: '8px 10px',
                borderRadius: 8,
                border: '1px solid var(--border)',
                background: 'var(--action-bar-bg)',
                color: 'var(--action-bar-fg)',
                cursor: 'pointer',
              }}
              title="Reload font (new internal family name)"
            >
              Reload
            </button>
          </div>
        </div>

        <div style={cardStyle}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
            <div style={{ fontSize: 13, fontWeight: 650 }}>Preview</div>
            <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
              Weights/styles may be synthesized if the font doesn’t provide them.
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
            {previewRows.map((row) => (
              <div key={`${row.label}-${row.weight}-${row.italic ? 'i' : 'n'}`} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ fontSize: 12, opacity: 0.75, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <span style={chipStyle}>{row.label}</span>
                  <span style={chipStyle}>w{row.weight}</span>
                  <span style={chipStyle}>{row.italic ? 'italic' : 'normal'}</span>
                </div>
                <div
                  style={{
                    fontFamily: `"${family}", system-ui, sans-serif`,
                    fontWeight: row.weight,
                    fontStyle: row.italic ? 'italic' : 'normal',
                    fontSize: 34,
                    lineHeight: 1.15,
                    letterSpacing: 0,
                    padding: '8px 2px',
                  }}
                >
                  {baseText}
                </div>
                <div
                  style={{
                    fontFamily: `"${family}", system-ui, sans-serif`,
                    fontWeight: row.weight,
                    fontStyle: row.italic ? 'italic' : 'normal',
                    fontSize: 18,
                    lineHeight: 1.35,
                    opacity: 0.95,
                    padding: '2px 2px 8px',
                  }}
                >
                  0123456789 — !@#$%^&*() []{} &lt;&gt; +=-_ “Quotes” ‘Apostrophes’
                </div>
                <div style={{ height: 1, background: 'rgba(255,255,255,0.08)' }} />
              </div>
            ))}
          </div>
        </div>

        <div style={cardStyle}>
          <div style={{ fontSize: 13, fontWeight: 650, marginBottom: 8 }}>Detected scripts / locale hints</div>
          {scripts.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
              No script coverage detected (or parser couldn’t read cmap). You can still preview the font above.
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {scripts.map((s) => (
                <span key={s.id} style={chipStyle} title={s.confidence === 'high' ? 'All test glyphs present' : 'Some test glyphs present'}>
                  <strong style={{ fontWeight: 650 }}>{s.label}</strong>
                  <span style={{ color: 'var(--fg-muted)' }}>{s.confidence}</span>
                </span>
              ))}
            </div>
          )}

          <div style={{ marginTop: 10, fontSize: 13, fontWeight: 650 }}>Sample phrases</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 8 }}>
            {samples.map((s) => (
              <div
                key={`${s.id}-${s.label}`}
                style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 10, background: 'var(--accent)' }}
              >
                <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginBottom: 6 }}>{s.label}</div>
                <div style={{ fontFamily: `"${family}", system-ui, sans-serif`, fontSize: 28, lineHeight: 1.2 }}>
                  {s.text}
                </div>
                <div style={{ fontFamily: `"${family}", system-ui, sans-serif`, fontSize: 18, lineHeight: 1.35, opacity: 0.9, marginTop: 6 }}>
                  {s.text.toUpperCase?.() ?? s.text}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

let reactRoot: Root | null = null;
let mountedRootEl: HTMLElement | null = null;

export async function mountViewer(root: HTMLElement, hostApi: HostApi, props: ViewerProps): Promise<void> {
  root.innerHTML = '';
  root.style.margin = '0';
  root.style.padding = '0';
  root.style.width = '100%';
  root.style.height = '100%';
  root.style.overflow = 'hidden';
  if (props.inline) root.tabIndex = -1;

  mountedRootEl = root;
  reactRoot = createRoot(root);
  reactRoot.render(<App hostApi={hostApi} viewerProps={props} />);
}

export function unmountViewer(): void {
  reactRoot?.unmount();
  reactRoot = null;
  if (mountedRootEl) mountedRootEl.innerHTML = '';
  mountedRootEl = null;
}

