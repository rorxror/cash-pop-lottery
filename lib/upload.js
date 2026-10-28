'use strict';
/* BP-21 (v19): dependency-free multipart/form-data parsing + private
   storage for KYC documents — the app's first file-upload surface.
   Safety model:
   - Files are parsed in memory with a hard cap (6 MB raw body, 5 MB file).
   - Only jpg/png/pdf are accepted, and the file's MAGIC BYTES must match
     the extension family — a renamed executable or script never passes.
   - Stored under a generated random hex name in a PRIVATE directory
     (never under public/, never the client-supplied filename), so path
     traversal is impossible by construction; reads go through
     resolveStoredPath which only accepts the generated-name shape. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_BODY_BYTES = 6 * 1024 * 1024;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const ALLOWED_EXTS = ['jpg', 'jpeg', 'png', 'pdf'];

/* Parse a multipart body. Returns { fields: {name: string}, file|null }
   where file = { field, filename, contentType, data: Buffer }.
   Throws Error with a player-safe message on malformed input. */
function parseMultipart(buffer, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/.exec(String(contentType || ''));
  if (!m) throw new Error('Upload could not be read (missing boundary).');
  const boundary = Buffer.from('--' + (m[1] || m[2]), 'latin1');
  const fields = {};
  let file = null;
  let pos = buffer.indexOf(boundary);
  if (pos === -1) throw new Error('Upload could not be read.');
  pos += boundary.length;
  while (pos < buffer.length) {
    // Each part starts after CRLF; the stream ends with "--".
    if (buffer[pos] === 0x2d && buffer[pos + 1] === 0x2d) break; // closing "--"
    if (buffer[pos] === 0x0d && buffer[pos + 1] === 0x0a) pos += 2;
    const headEnd = buffer.indexOf('\r\n\r\n', pos, 'latin1');
    if (headEnd === -1) break;
    const head = buffer.toString('latin1', pos, headEnd);
    const bodyStart = headEnd + 4;
    // Part body ends at CRLF + boundary.
    let bodyEnd = buffer.indexOf(boundary, bodyStart);
    if (bodyEnd === -1) break;
    /* SCAN fix (B-06): only strip the two bytes before the boundary
       when they really are the CRLF separator — otherwise the part is
       malformed (or a file's bytes collided with the boundary) and the
       whole upload is refused instead of silently truncated. */
    if (bodyEnd - 2 < bodyStart || buffer[bodyEnd - 2] !== 0x0d || buffer[bodyEnd - 1] !== 0x0a) {
      throw new Error('Upload could not be read (malformed part).');
    }
    bodyEnd -= 2; // strip the CRLF before the boundary
    const body = buffer.subarray(bodyStart, bodyEnd);
    const disp = /content-disposition:\s*form-data([^\r\n]*)/i.exec(head);
    if (disp) {
      const nameM = /name="([^"]*)"/.exec(disp[1]);
      const fileM = /filename="([^"]*)"/.exec(disp[1]);
      const name = nameM ? nameM[1] : '';
      /* SCAN fix (B-06): nothing may follow the file part. A boundary
         sequence embedded in file bytes would otherwise end the file
         early and let the remainder pose as extra form fields (the
         auditor's proof overwrote doc_type this way). The app's only
         multipart form puts the file last, so any later part means
         the upload is corrupt or crafted — refuse it whole. */
      if (file) throw new Error('Upload could not be read (unexpected content after the file).');
      if (fileM) {
        if (file) throw new Error('Please upload one document at a time.');
        const ctM = /content-type:\s*([^\r\n]+)/i.exec(head);
        file = { field: name, filename: fileM[1], contentType: ctM ? ctM[1].trim() : '', data: Buffer.from(body) };
      } else if (name) {
        fields[name] = body.toString('utf8');
      }
    }
    pos = bodyEnd + 2 + boundary.length;
  }
  return { fields, file };
}

function sniffType(data) {
  if (!data || data.length < 4) return null;
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpg';
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47 && data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a) return 'png';
  if (data.length >= 5 && data.toString('latin1', 0, 5) === '%PDF-') return 'pdf';
  return null;
}
function extOf(filename) {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(filename || '').trim());
  return m ? m[1].toLowerCase() : '';
}
/* Validate an uploaded file part. Returns { ok, ext } or { ok:false, error }. */
function validateUpload(file) {
  if (!file || !file.data) return { ok: false, error: 'Please choose a document file to upload.' };
  if (file.data.length === 0) return { ok: false, error: 'The uploaded file is empty.' };
  if (file.data.length > MAX_FILE_BYTES) return { ok: false, error: 'Document is too large (maximum 5 MB).' };
  const ext = extOf(file.filename);
  if (!ALLOWED_EXTS.includes(ext)) return { ok: false, error: 'Only JPG, PNG or PDF documents are accepted.' };
  const sniffed = sniffType(file.data);
  const family = ext === 'jpeg' ? 'jpg' : ext;
  if (!sniffed || sniffed !== family) return { ok: false, error: 'The file content does not match its type — please upload a genuine JPG, PNG or PDF.' };
  return { ok: true, ext: family };
}

/* Private storage directory: KYC_UPLOAD_DIR env wins; otherwise a folder
   NEXT TO the SQLite database file (so a persistent disk mounted for the
   DB also holds the documents); fallback <app>/data/kyc-uploads. */
function uploadDir() {
  if (process.env.KYC_UPLOAD_DIR) return process.env.KYC_UPLOAD_DIR;
  const sqlitePath = process.env.SQLITE_PATH;
  if (sqlitePath && sqlitePath !== ':memory:') return path.join(path.dirname(path.resolve(sqlitePath)), 'kyc-uploads');
  return path.join(__dirname, '..', 'data', 'kyc-uploads');
}
const STORED_NAME_RE = /^[a-f0-9]{32}\.(jpg|png|pdf)$/;
function storeUpload(data, ext) {
  const dir = uploadDir();
  fs.mkdirSync(dir, { recursive: true });
  const name = crypto.randomBytes(16).toString('hex') + '.' + ext;
  fs.writeFileSync(path.join(dir, name), data, { mode: 0o600 });
  return name;
}
/* Only the generated-name shape resolves — anything else (including any
   traversal attempt) returns null. */
function resolveStoredPath(storedName) {
  if (!STORED_NAME_RE.test(String(storedName || ''))) return null;
  return path.join(uploadDir(), storedName);
}
function readStored(storedName) {
  const p = resolveStoredPath(storedName);
  if (!p) return null;
  try { return fs.readFileSync(p); } catch { return null; }
}
const CONTENT_TYPES = { jpg: 'image/jpeg', png: 'image/png', pdf: 'application/pdf' };

module.exports = { parseMultipart, sniffType, extOf, validateUpload, uploadDir, storeUpload, resolveStoredPath, readStored, CONTENT_TYPES, MAX_BODY_BYTES, MAX_FILE_BYTES };
