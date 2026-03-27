//! .dir fsProvider backend plugin for ISO 9660 disc images.
//!
//! Implements the .dir WASM plugin ABI:
//!   Exports: get_input_ptr, get_output_ptr, plugin_list, plugin_read
//!   Imports: host_read_range, host_log, host_receive_bytes
//!
//! Supports ISO 9660 Level 1 / Level 2, with Joliet (UCS-2) preferred when
//! available for proper mixed-case and Unicode filenames.
//!
//! Sectors are read on demand — the full image is never loaded into memory,
//! making the plugin usable with large DVD/Blu-ray images.

#![allow(static_mut_refs)]

use serde::Serialize;
use std::cmp::Ordering;

// ── Host imports ──────────────────────────────────────────────────────

extern "C" {
    /// Read `len` bytes at `offset` from the container file into `out_ptr`.
    /// Returns bytes actually read, or a negative value on error.
    fn host_read_range(offset: i64, len: i64, out_ptr: *mut u8) -> i32;

    /// Write a UTF-8 string to the host log.
    fn host_log(ptr: *const u8, len: i32);

    /// Stream `len` bytes at `ptr` to the host accumulation buffer.
    /// Returns `len` on success, negative on error.
    fn host_receive_bytes(ptr: *const u8, len: i32) -> i32;
}

// ── Static buffers ────────────────────────────────────────────────────

const INPUT_SIZE: usize = 128 * 1024;       // 128 KB (for container + inner paths)
const OUTPUT_SIZE: usize = 4 * 1024 * 1024; // 4 MB (for directory listing JSON)

static mut INPUT_BUF: [u8; INPUT_SIZE] = [0u8; INPUT_SIZE];
static mut OUTPUT_BUF: [u8; OUTPUT_SIZE] = [0u8; OUTPUT_SIZE];

#[no_mangle]
pub extern "C" fn get_input_ptr() -> i32 {
    unsafe { INPUT_BUF.as_ptr() as i32 }
}

#[no_mangle]
pub extern "C" fn get_output_ptr() -> i32 {
    unsafe { OUTPUT_BUF.as_ptr() as i32 }
}

// ── Helpers ───────────────────────────────────────────────────────────

fn log(msg: &str) {
    let b = msg.as_bytes();
    unsafe { host_log(b.as_ptr(), b.len() as i32) };
}

/// Parse container_path and inner_path from the input buffer.
/// Format: [cp_len: 4 LE][cp bytes][ip_len: 4 LE][ip bytes]
fn read_inputs() -> (String, String) {
    unsafe {
        let buf = &INPUT_BUF;
        let mut pos = 0usize;

        let cp_len = u32::from_le_bytes(buf[pos..pos + 4].try_into().unwrap()) as usize;
        pos += 4;
        let container_path =
            std::str::from_utf8(&buf[pos..pos + cp_len]).unwrap_or("").to_string();
        pos += cp_len;

        let ip_len = u32::from_le_bytes(buf[pos..pos + 4].try_into().unwrap()) as usize;
        pos += 4;
        let inner_path =
            std::str::from_utf8(&buf[pos..pos + ip_len]).unwrap_or("/").to_string();

        (container_path, inner_path)
    }
}

// ── ISO 9660 low-level I/O ────────────────────────────────────────────

const SECTOR_SIZE: usize = 2048;
const READ_CHUNK: usize = 64 * 1024; // 64 KB per host_read_range call

fn read_u32_le(b: &[u8]) -> u32 {
    u32::from_le_bytes([b[0], b[1], b[2], b[3]])
}

/// Read `length` bytes from the ISO at byte offset `lba * SECTOR_SIZE`.
fn read_extent(lba: u32, length: u32) -> Vec<u8> {
    let base = lba as i64 * SECTOR_SIZE as i64;
    let mut data = Vec::with_capacity(length as usize);
    let mut pos = 0i64;
    while pos < length as i64 {
        let chunk = READ_CHUNK.min((length as i64 - pos) as usize);
        let mut buf = vec![0u8; chunk];
        let n = unsafe { host_read_range(base + pos, chunk as i64, buf.as_mut_ptr()) };
        if n <= 0 {
            break;
        }
        data.extend_from_slice(&buf[..n as usize]);
        pos += n as i64;
    }
    data
}

/// Read a single 2048-byte sector.
fn read_sector(lba: u32) -> Vec<u8> {
    read_extent(lba, SECTOR_SIZE as u32)
}

// ── ISO 9660 directory record parser ─────────────────────────────────

struct DirEntry {
    name: String,
    is_dir: bool,
    extent_lba: u32,
    data_length: u32,
}

/// Decode a Joliet UCS-2 big-endian identifier to a Rust String.
fn ucs2_to_string(bytes: &[u8]) -> String {
    let units: Vec<u16> = bytes
        .chunks(2)
        .map(|c| u16::from_be_bytes([c[0], c.get(1).copied().unwrap_or(0)]))
        .collect();
    String::from_utf16_lossy(&units).to_string()
}

/// Strip the ISO 9660 version suffix (`;1`, `;2`, …) from a name.
fn strip_version(name: &str) -> &str {
    match name.rfind(';') {
        Some(pos) => &name[..pos],
        None => name,
    }
}

/// Parse all directory records from raw directory data.
///
/// Records cannot span sector boundaries — zero bytes at a sector boundary
/// are padding and we skip to the next sector.
fn parse_dir_records(data: &[u8], use_joliet: bool) -> Vec<DirEntry> {
    let mut entries = Vec::new();
    let mut offset = 0;

    while offset < data.len() {
        let record_len = data[offset] as usize;
        if record_len == 0 {
            // Padding — advance to the start of the next sector.
            let sector_start = (offset / SECTOR_SIZE) * SECTOR_SIZE;
            let next_sector = sector_start + SECTOR_SIZE;
            if next_sector >= data.len() {
                break;
            }
            offset = next_sector;
            continue;
        }
        if record_len < 34 || offset + record_len > data.len() {
            break;
        }

        let record = &data[offset..offset + record_len];
        let extent_lba = read_u32_le(&record[2..6]);
        let data_length = read_u32_le(&record[10..14]);
        let file_flags = record[25];
        let is_dir = (file_flags & 0x02) != 0;
        let id_len = record[32] as usize;

        if id_len == 0 || 33 + id_len > record.len() {
            offset += record_len;
            continue;
        }

        let id_bytes = &record[33..33 + id_len];

        // Skip "." (single 0x00) and ".." (single 0x01) entries.
        if id_bytes == [0x00] || id_bytes == [0x01] {
            offset += record_len;
            continue;
        }

        let name = if use_joliet {
            // UCS-2 big-endian; strip optional version suffix.
            let raw = ucs2_to_string(id_bytes);
            strip_version(&raw).to_string()
        } else {
            // ASCII; strip version suffix and trailing dot (files without extension).
            let raw = std::str::from_utf8(id_bytes).unwrap_or("").to_string();
            strip_version(&raw).trim_end_matches('.').to_string()
        };

        if !name.is_empty() {
            entries.push(DirEntry { name, is_dir, extent_lba, data_length });
        }

        offset += record_len;
    }

    entries
}

// ── ISO filesystem navigator ──────────────────────────────────────────

struct IsoFs {
    root_lba: u32,
    root_len: u32,
    use_joliet: bool,
}

impl IsoFs {
    /// Scan the Volume Descriptor Set (starting at sector 16) and build
    /// an IsoFs using the Joliet SVD when available, PVD otherwise.
    fn from_disk() -> Option<Self> {
        let mut pvd_root: Option<(u32, u32)> = None;
        let mut joliet_root: Option<(u32, u32)> = None;

        // Volume descriptors begin at sector 16.  In practice there are only
        // ever a handful before the terminator, so cap the scan at 32.
        for sector_num in 16u32..48 {
            let sector = read_sector(sector_num);
            if sector.len() < 190 {
                break;
            }
            if &sector[1..6] != b"CD001" {
                break;
            }

            match sector[0] {
                1 => {
                    // Primary Volume Descriptor — root dir record at offset 156.
                    let lba = read_u32_le(&sector[158..162]);
                    let len = read_u32_le(&sector[166..170]);
                    pvd_root = Some((lba, len));
                }
                2 => {
                    // Supplementary Volume Descriptor — Joliet check via escape sequences.
                    let esc = &sector[88..91];
                    if esc == b"%/@" || esc == b"%/C" || esc == b"%/E" {
                        let lba = read_u32_le(&sector[158..162]);
                        let len = read_u32_le(&sector[166..170]);
                        joliet_root = Some((lba, len));
                    }
                }
                255 => break, // Volume Descriptor Set Terminator
                _ => {}
            }
        }

        if let Some((lba, len)) = joliet_root {
            Some(IsoFs { root_lba: lba, root_len: len, use_joliet: true })
        } else if let Some((lba, len)) = pvd_root {
            Some(IsoFs { root_lba: lba, root_len: len, use_joliet: false })
        } else {
            None
        }
    }

    /// Walk `inner_path` from the root and return the LBA + length of the
    /// target directory, or `None` if not found.
    fn find_dir(&self, inner_path: &str) -> Option<(u32, u32)> {
        let parts: Vec<&str> = inner_path
            .trim_matches('/')
            .split('/')
            .filter(|s| !s.is_empty())
            .collect();

        let mut lba = self.root_lba;
        let mut len = self.root_len;

        for part in parts {
            let dir_data = read_extent(lba, len);
            let entries = parse_dir_records(&dir_data, self.use_joliet);
            let entry = entries
                .iter()
                .find(|e| e.is_dir && e.name.to_lowercase() == part.to_lowercase())?;
            lba = entry.extent_lba;
            len = entry.data_length;
        }

        Some((lba, len))
    }

    /// Walk `inner_path` and return the LBA + byte-length of the target file.
    fn find_file(&self, inner_path: &str) -> Option<(u32, u32)> {
        let path = inner_path.trim_matches('/');
        let (dir_path, file_name) = match path.rfind('/') {
            Some(pos) => (&path[..pos], &path[pos + 1..]),
            None => ("", path),
        };

        let (dir_lba, dir_len) = if dir_path.is_empty() {
            (self.root_lba, self.root_len)
        } else {
            self.find_dir(dir_path)?
        };

        let dir_data = read_extent(dir_lba, dir_len);
        let entries = parse_dir_records(&dir_data, self.use_joliet);
        let entry = entries
            .iter()
            .find(|e| !e.is_dir && e.name.to_lowercase() == file_name.to_lowercase())?;

        Some((entry.extent_lba, entry.data_length))
    }
}

// ── Exported plugin functions ─────────────────────────────────────────

#[derive(Serialize)]
struct JsonEntry {
    name: String,
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    size: Option<f64>,
}

/// List entries at `inner_path` inside the ISO image.
/// Writes JSON to OUTPUT_BUF; returns bytes written or negative on error.
#[no_mangle]
pub extern "C" fn plugin_list() -> i32 {
    let (_container_path, inner_path) = read_inputs();

    let iso = match IsoFs::from_disk() {
        Some(fs) => fs,
        None => {
            log("iso-provider: not a valid ISO 9660 image");
            return -1;
        }
    };

    let (dir_lba, dir_len) = match iso.find_dir(&inner_path) {
        Some(d) => d,
        None => {
            // The path is not a directory (it's a file, or the root of a copy operation).
            // Return an empty list so collectContainerFiles treats it as a leaf file.
            let empty = b"[]";
            unsafe { OUTPUT_BUF[..2].copy_from_slice(empty); }
            return 2;
        }
    };

    let dir_data = read_extent(dir_lba, dir_len);
    let mut entries = parse_dir_records(&dir_data, iso.use_joliet);

    // Directories first, then case-insensitive name order.
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => Ordering::Less,
        (false, true) => Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    let json_entries: Vec<JsonEntry> = entries
        .into_iter()
        .map(|e| JsonEntry {
            size: if e.is_dir { None } else { Some(e.data_length as f64) },
            kind: if e.is_dir { "directory" } else { "file" },
            name: e.name,
        })
        .collect();

    let json = match serde_json::to_vec(&json_entries) {
        Ok(j) => j,
        Err(e) => {
            log(&e.to_string());
            return -1;
        }
    };

    if json.len() > OUTPUT_SIZE {
        log("iso-provider: listing JSON exceeds output buffer");
        return -1;
    }

    unsafe {
        OUTPUT_BUF[..json.len()].copy_from_slice(&json);
    }
    json.len() as i32
}

/// Read a byte range of a file at `inner_path`.
/// Streams bytes to the host via `host_receive_bytes`; returns total bytes sent or negative on error.
#[no_mangle]
pub extern "C" fn plugin_read(offset: i64, len: i64) -> i32 {
    let (_container_path, inner_path) = read_inputs();

    let iso = match IsoFs::from_disk() {
        Some(fs) => fs,
        None => {
            log("iso-provider: not a valid ISO 9660 image");
            return -1;
        }
    };

    let (file_lba, file_len) = match iso.find_file(&inner_path) {
        Some(f) => f,
        None => {
            log("iso-provider: file not found");
            return -1;
        }
    };

    // Clamp the requested range to the file's actual size.
    let file_size = file_len as i64;
    let start = offset.min(file_size);
    let end = (offset + len).min(file_size);
    if start >= end {
        return 0;
    }

    // ISO 9660 files are stored as contiguous extents — no decompression needed.
    // Read directly from the image at the right byte offset and stream to host.
    let read_base = file_lba as i64 * SECTOR_SIZE as i64 + start;
    let read_len = (end - start) as usize;
    let mut pos = 0;
    let mut total_sent = 0i32;

    while pos < read_len {
        let chunk = READ_CHUNK.min(read_len - pos);
        let mut buf = vec![0u8; chunk];
        let n = unsafe { host_read_range(read_base + pos as i64, chunk as i64, buf.as_mut_ptr()) };
        if n <= 0 {
            break;
        }
        let rc = unsafe { host_receive_bytes(buf.as_ptr(), n) };
        if rc < 0 {
            log("iso-provider: host_receive_bytes failed");
            return -1;
        }
        total_sent += n;
        pos += n as usize;
    }

    total_sent
}
