const { t } = require('../i18n');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const HOME = os.homedir();
const DAY = 86400000;

function walk(dir, filter, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, filter, out);
    else if (!filter || filter(p)) out.push(p);
  }
  return out;
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

/** Local-time day key, YYYY-MM-DD. */
function dayKey(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Reads complete lines appended to `file` since `offset`.
 * Returns the new offset (end of the last complete line).
 */
function readLinesFrom(file, offset, onLine) {
  const fd = fs.openSync(file, 'r');
  try {
    const chunk = Buffer.allocUnsafe(4 << 20);
    let carry = null; // bytes of a line that spans chunks
    let pos = offset;
    let done = offset; // offset just past the last complete line
    for (;;) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, pos);
      if (n <= 0) break;
      let start = 0;
      for (;;) {
        const nl = chunk.indexOf(0x0a, start);
        if (nl === -1 || nl >= n) break;
        let piece = chunk.subarray(start, nl);
        if (carry) { piece = Buffer.concat([carry, piece]); carry = null; }
        if (piece.length) onLine(piece.toString('utf8'));
        start = nl + 1;
        done = pos + start;
      }
      if (start < n) {
        const rest = Buffer.from(chunk.subarray(start, n));
        carry = carry ? Buffer.concat([carry, rest]) : rest;
      }
      pos += n;
    }
    return done; // a half-written last line is left for the next pass
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Per-source-file cache. Each tracked log file gets one small JSON so that
 * only files that actually changed are rewritten.
 */
class FileCache {
  constructor(dir) {
    this.dir = dir;
    this.mem = new Map();
  }
  get(file) {
    if (!this.mem.has(file)) {
      this.mem.set(file, readJson(path.join(this.dir, hash(file) + '.json')) || { offset: 0, size: 0, mtime: 0, data: {} });
    }
    return this.mem.get(file);
  }
  save(file) {
    writeJson(path.join(this.dir, hash(file) + '.json'), this.mem.get(file));
  }
}

/** Adds a usage record into a `day|model` bucket map. */
function addBucket(buckets, ts, model, u) {
  const key = dayKey(ts) + '|' + (model || 'unknown');
  const b = buckets[key] || (buckets[key] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0, cost: 0, hasCost: false });
  b.input += u.input || 0;
  b.output += u.output || 0;
  b.cacheRead += u.cacheRead || 0;
  b.cacheWrite += u.cacheWrite || 0;
  b.requests += u.requests ?? 1;
  if (u.cost != null) { b.cost += u.cost; b.hasCost = true; }
}

/** Finds a CLI executable on PATH or in the given extra folders. */
function findBinary(name, extraDirs = []) {
  const dirs = [...extraDirs, ...(process.env.PATH || '').split(path.delimiter)].filter(Boolean);
  for (const dir of dirs) {
    for (const ext of ['.exe', '.cmd', '.bat']) {
      const p = path.join(dir, name + ext);
      try { if (fs.statSync(p).isFile()) return p; } catch { /* keep looking */ }
    }
  }
  return null;
}

function windowLabel(seconds) {
  if (!seconds) return t('Limit');
  const h = seconds / 3600;
  if (h <= 6) return t('{n} hours', { n: Math.round(h) });
  if (h <= 30) return t('Daily');
  if (h <= 24 * 8) return t('Weekly');
  if (h <= 24 * 32) return t('Monthly');
  return t('Period');
}

module.exports = { HOME, DAY, walk, readJson, writeJson, hash, dayKey, readLinesFrom, FileCache, addBucket, windowLabel, findBinary };
