//! Faraday fsProvider backend plugin for ZIP archives.
//!
//! Implements the Faraday WASM plugin ABI:
//!   Exports: get_input_ptr, get_output_ptr, plugin_list, plugin_read
//!   Imports: host_read_range, host_log
//!
//! The host writes the container path and inner path into the input buffer
//! before each call. The plugin reads the ZIP from disk via host_read_range,
//! parses it, and writes JSON (for list) or raw bytes (for read) to the
//! output buffer.

#![allow(static_mut_refs)]

use serde::Serialize;
use std::cmp::Ordering;
use std::collections::HashMap;
use std::io::{Cursor, Read};
use zip::ZipArchive;

// ── Host imports ─────────────────────────────────────────────────────

extern "C" {
    /// Read `len` bytes at `offset` from the container file into `out_ptr`.
    /// Returns bytes actually read, or a negative value on error.
    fn host_read_range(offset: i64, len: i64, out_ptr: *mut u8) -> i32;

    /// Write a UTF-8 string to the host log.
    fn host_log(ptr: *const u8, len: i32);

    /// Stream `len` bytes at `ptr` to the host accumulation buffer.
    /// Used by plugin_read to bypass the fixed-size OUTPUT_BUF for large files.
    /// Returns `len` on success, negative on error.
    fn host_receive_bytes(ptr: *const u8, len: i32) -> i32;
}

// ── Static buffers ────────────────────────────────────────────────────

const INPUT_SIZE: usize = 128 * 1024;       // 128 KB
const OUTPUT_SIZE: usize = 4 * 1024 * 1024; // 4 MB

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

/// Read the entire container file via host_read_range.
fn read_container() -> Vec<u8> {
    const CHUNK: usize = 64 * 1024;
    let mut data: Vec<u8> = Vec::new();
    let mut tmp = [0u8; CHUNK];
    let mut offset: i64 = 0;
    loop {
        let n = unsafe { host_read_range(offset, CHUNK as i64, tmp.as_mut_ptr()) };
        if n <= 0 {
            break;
        }
        data.extend_from_slice(&tmp[..n as usize]);
        offset += n as i64;
        if (n as usize) < CHUNK {
            break; // reached EOF
        }
    }
    data
}

// ── Entry types ───────────────────────────────────────────────────────

#[derive(Serialize)]
struct Entry {
    name: String,
    kind: &'static str, // "file" | "directory"
    #[serde(skip_serializing_if = "Option::is_none")]
    size: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    mtime_ms: Option<f64>,
}

// ── ZIP listing ───────────────────────────────────────────────────────

fn list_zip(data: Vec<u8>, inner_path: &str) -> Result<Vec<Entry>, String> {
    let cursor = Cursor::new(data);
    let mut archive =
        ZipArchive::new(cursor).map_err(|e| format!("Not a valid ZIP archive: {}", e))?;

    // Normalise the directory prefix we're listing.
    // inner_path "/" → prefix ""   (root)
    // inner_path "/src" → prefix "src/"
    let prefix: String = if inner_path == "/" || inner_path.is_empty() {
        String::new()
    } else {
        format!("{}/", inner_path.trim_matches('/'))
    };

    // Collect direct children; use a HashMap to deduplicate pseudo-directories.
    let mut children: HashMap<String, Entry> = HashMap::new();

    for i in 0..archive.len() {
        let file = match archive.by_index(i) {
            Ok(f) => f,
            Err(_) => continue,
        };
        let raw_name = file.name().to_string();

        // Skip entries not under our prefix.
        if !raw_name.starts_with(&prefix) {
            continue;
        }

        let rel = &raw_name[prefix.len()..]; // relative to current dir
        if rel.is_empty() {
            continue; // directory entry for the current prefix itself
        }

        if let Some(slash) = rel.find('/') {
            // Entry is inside a sub-directory → emit the sub-dir name.
            let dir_name = &rel[..slash];
            if !dir_name.is_empty() {
                children.entry(dir_name.to_string()).or_insert(Entry {
                    name: dir_name.to_string(),
                    kind: "directory",
                    size: None,
                    mtime_ms: None,
                });
            }
        } else {
            // Direct child file.
            let entry_name = rel.trim_end_matches('/').to_string();
            if !entry_name.is_empty() {
                let is_dir = file.is_dir();
                children.entry(entry_name.clone()).or_insert(Entry {
                    name: entry_name,
                    kind: if is_dir { "directory" } else { "file" },
                    size: if is_dir { None } else { Some(file.size() as f64) },
                    mtime_ms: None,
                });
            }
        }
    }

    // Sort: directories first, then case-insensitive name order.
    let mut entries: Vec<Entry> = children.into_values().collect();
    entries.sort_by(|a, b| match (a.kind, b.kind) {
        ("directory", "file") => Ordering::Less,
        ("file", "directory") => Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(entries)
}

// ── ZIP file read ─────────────────────────────────────────────────────

fn read_zip_file(data: Vec<u8>, inner_path: &str, offset: i64, len: i64) -> Result<Vec<u8>, String> {
    let cursor = Cursor::new(data);
    let mut archive =
        ZipArchive::new(cursor).map_err(|e| format!("Not a valid ZIP archive: {}", e))?;

    let entry_name = inner_path.trim_start_matches('/');
    let mut file = archive
        .by_name(entry_name)
        .map_err(|_| format!("Entry not found: {}", entry_name))?;

    // Decompress the full entry first, then slice.
    let mut all_bytes: Vec<u8> = Vec::with_capacity(file.size() as usize);
    file.read_to_end(&mut all_bytes)
        .map_err(|e| format!("Failed to decompress entry: {}", e))?;

    let start = (offset as usize).min(all_bytes.len());
    let end = ((offset + len) as usize).min(all_bytes.len());
    Ok(all_bytes[start..end].to_vec())
}

// ── Exported plugin functions ─────────────────────────────────────────

/// List entries at inner_path inside the ZIP at container_path.
/// Writes JSON to the output buffer; returns bytes written or negative on error.
#[no_mangle]
pub extern "C" fn plugin_list() -> i32 {
    let (_container_path, inner_path) = read_inputs();

    let data = read_container();
    if data.is_empty() {
        log("zip-provider: failed to read container file");
        return -1;
    }

    let entries = match list_zip(data, &inner_path) {
        Ok(e) => e,
        Err(e) => {
            log(&e);
            return -1;
        }
    };

    let json = match serde_json::to_vec(&entries) {
        Ok(j) => j,
        Err(e) => {
            log(&e.to_string());
            return -1;
        }
    };

    if json.len() > OUTPUT_SIZE {
        log("zip-provider: listing JSON exceeds output buffer");
        return -1;
    }

    unsafe {
        OUTPUT_BUF[..json.len()].copy_from_slice(&json);
    }
    json.len() as i32
}

/// Read a byte range of an entry at inner_path.
/// Streams raw bytes to the host via host_receive_bytes; returns total bytes sent or negative on error.
#[no_mangle]
pub extern "C" fn plugin_read(offset: i64, len: i64) -> i32 {
    let (_container_path, inner_path) = read_inputs();

    let data = read_container();
    if data.is_empty() {
        log("zip-provider: failed to read container file");
        return -1;
    }

    let bytes = match read_zip_file(data, &inner_path, offset, len) {
        Ok(b) => b,
        Err(e) => {
            log(&e);
            return -1;
        }
    };

    let total = bytes.len() as i32;
    let rc = unsafe { host_receive_bytes(bytes.as_ptr(), total) };
    if rc < 0 {
        log("zip-provider: host_receive_bytes failed");
        return -1;
    }
    total
}
