#!/usr/bin/env node
/**
 * 📚 私人小说管理站 — Express 后端
 * 双模式：本地 (sql.js) / Vercel (Turso + Blob)
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

// -------------------------------------------------------------------------
// Mode detection
// -------------------------------------------------------------------------
const IS_VERCEL = !!process.env.VERCEL;

// -------------------------------------------------------------------------
// App setup
// -------------------------------------------------------------------------
const app = express();
const PORT = process.env.PORT || 5000;
const CHARS_PER_PAGE = 2000;
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

const NOVELS_DIR = path.join(__dirname, 'novels');
const DB_PATH = path.join(__dirname, 'database.db');

if (!IS_VERCEL) fs.mkdirSync(NOVELS_DIR, { recursive: true });

// -------------------------------------------------------------------------
// Database abstraction (async — works with sql.js OR Turso)
// -------------------------------------------------------------------------
let SQL;          // sql.js init function
let localDb;      // sql.js Database instance
let remoteDb;     // Turso client

async function initDatabase() {
  if (IS_VERCEL) {
    const { createClient } = require('@libsql/client');
    remoteDb = createClient({
      url: process.env.TURSO_DATABASE_URL,
      authToken: process.env.TURSO_AUTH_TOKEN,
    });
    await remoteDb.execute(`
      CREATE TABLE IF NOT EXISTS books (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        title       TEXT    NOT NULL,
        author      TEXT    DEFAULT '',
        description TEXT    DEFAULT '',
        filename    TEXT    NOT NULL,
        file_size   INTEGER DEFAULT 0,
        total_chars INTEGER DEFAULT 0,
        total_pages INTEGER DEFAULT 0,
        rating      INTEGER DEFAULT 0,
        is_favorite INTEGER DEFAULT 0,
        created_at  TEXT    DEFAULT (datetime('now','localtime')),
        updated_at  TEXT    DEFAULT (datetime('now','localtime'))
      )
    `);
    await remoteDb.execute(`
      CREATE TABLE IF NOT EXISTS reading_progress (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id      INTEGER NOT NULL UNIQUE,
        current_page INTEGER DEFAULT 1,
        font_size    INTEGER DEFAULT 18,
        theme        TEXT    DEFAULT 'light',
        FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
      )
    `);
    // Migrate existing tables — add columns if they don't exist
    try { await remoteDb.execute("ALTER TABLE books ADD COLUMN rating INTEGER DEFAULT 0"); } catch {}
    try { await remoteDb.execute("ALTER TABLE books ADD COLUMN is_favorite INTEGER DEFAULT 0"); } catch {}
  } else {
    const initSqlJs = require('sql.js');
    SQL = await initSqlJs();
    if (fs.existsSync(DB_PATH)) {
      localDb = new SQL.Database(fs.readFileSync(DB_PATH));
    } else {
      localDb = new SQL.Database();
    }
    localDb.run("PRAGMA foreign_keys = ON");
    localDb.run(`CREATE TABLE IF NOT EXISTS books (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, author TEXT DEFAULT '',
      description TEXT DEFAULT '', filename TEXT NOT NULL, file_size INTEGER DEFAULT 0,
      total_chars INTEGER DEFAULT 0, total_pages INTEGER DEFAULT 0,
      rating INTEGER DEFAULT 0, is_favorite INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime')))`);
    // Migrate existing tables
    try { localDb.run("ALTER TABLE books ADD COLUMN rating INTEGER DEFAULT 0"); } catch {}
    try { localDb.run("ALTER TABLE books ADD COLUMN is_favorite INTEGER DEFAULT 0"); } catch {}
    localDb.run(`CREATE TABLE IF NOT EXISTS reading_progress (
      id INTEGER PRIMARY KEY AUTOINCREMENT, book_id INTEGER NOT NULL UNIQUE,
      current_page INTEGER DEFAULT 1, font_size INTEGER DEFAULT 18, theme TEXT DEFAULT 'light',
      FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE)`);
    saveLocalDb();
  }
}

function saveLocalDb() {
  if (!IS_VERCEL && localDb) {
    fs.writeFileSync(DB_PATH, Buffer.from(localDb.export()));
  }
}

// ---- Async DB helpers ------------------------------------------------

async function dbAll(sql, params = []) {
  if (IS_VERCEL) {
    const result = await remoteDb.execute({ sql, args: params });
    return result.rows;
  }
  const stmt = localDb.prepare(sql);
  if (params.length) stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

async function dbGet(sql, params = []) {
  const rows = await dbAll(sql, params);
  return rows.length ? rows[0] : null;
}

async function dbRun(sql, params = []) {
  if (IS_VERCEL) {
    const result = await remoteDb.execute({ sql, args: params });
    return { changes: Number(result.rowsAffected), lastInsertRowid: Number(result.lastInsertRowid) };
  }
  localDb.run(sql, params);
  saveLocalDb();
  const idResult = localDb.exec("SELECT last_insert_rowid()");
  return { changes: localDb.getRowsModified(), lastInsertRowid: idResult[0]?.values[0][0] };
}

// ---- File storage abstraction ----------------------------------------

async function saveNovelFile(buffer, originalName) {
  const ts = new Date().toISOString().replace(/[:.]/g, '');
  const name = `${ts}_${originalName}`;
  if (IS_VERCEL) {
    const { put } = require('@vercel/blob');
    const blob = await put(`novels/${name}`, buffer, { access: 'private' });
    return blob.url;     // stored as full URL (含鉴权 token)
  }
  fs.writeFileSync(path.join(NOVELS_DIR, name), buffer);
  return name;           // stored as local filename
}

async function readNovelFile(identifier) {
  if (IS_VERCEL) {
    const resp = await fetch(identifier);
    const buf = await resp.arrayBuffer();
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
      return new TextDecoder('latin1').decode(buf);
    }
  }
  const filepath = identifier.startsWith('/') ? identifier : path.join(NOVELS_DIR, identifier);
  try { return fs.readFileSync(filepath, 'utf-8'); }
  catch { return fs.readFileSync(filepath, 'gbk'); }
}

async function deleteNovelFile(identifier) {
  if (IS_VERCEL) {
    const { del } = require('@vercel/blob');
    await del(identifier);
    return;
  }
  const filepath = path.join(NOVELS_DIR, identifier);
  if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
}

// -------------------------------------------------------------------------
// Utilities
// -------------------------------------------------------------------------

function countDisplayChars(text) {
  return text.replace(/\n/g, '').replace(/\r/g, '').length;
}

function splitIntoPages(text, charsPerPage) {
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const pages = [];
  let pos = 0;
  while (pos < text.length) {
    let end = Math.min(pos + charsPerPage, text.length);
    if (end < text.length) {
      const nl = text.lastIndexOf('\n', end);
      if (nl > pos && end - nl < charsPerPage * 0.3) end = nl + 1;
    }
    pages.push(text.slice(pos, end));
    pos = end;
  }
  return pages;
}

async function getOrCreateProgress(bookId) {
  let row = await dbGet('SELECT * FROM reading_progress WHERE book_id = ?', [bookId]);
  if (!row) {
    await dbRun('INSERT INTO reading_progress (book_id) VALUES (?)', [bookId]);
    row = await dbGet('SELECT * FROM reading_progress WHERE book_id = ?', [bookId]);
  }
  return row;
}

function coverColorClass(bookId) {
  return `color-${((bookId - 1) % 10) + 1}`;
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

// -------------------------------------------------------------------------
// Middleware
// -------------------------------------------------------------------------

// Init DB before handling requests
app.use(async (req, res, next) => {
  if (!global._dbReady) {
    await initDatabase();
    global._dbReady = true;
  }
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const storage = IS_VERCEL
  ? multer.memoryStorage()
  : multer.diskStorage({
      destination: (req, file, cb) => cb(null, NOVELS_DIR),
      filename: (req, file, cb) => {
        const ts = new Date().toISOString().replace(/[:.]/g, '');
        cb(null, `${ts}_${file.originalname}`);
      }
    });

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    if (!file.originalname.toLowerCase().endsWith('.txt')) {
      return cb(new Error('仅支持 .txt 文件'));
    }
    cb(null, true);
  }
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// -------------------------------------------------------------------------
// Routes – Books CRUD
// -------------------------------------------------------------------------

app.get('/', async (req, res) => {
  const q = (req.query.q || '').trim();
  const showFav = req.query.fav === '1';
  let books;
  if (showFav) {
    books = await dbAll("SELECT * FROM books WHERE is_favorite = 1 ORDER BY updated_at DESC");
  } else if (q) {
    books = await dbAll("SELECT * FROM books WHERE (title LIKE ? OR author LIKE ?) ORDER BY updated_at DESC", [`%${q}%`, `%${q}%`]);
  } else {
    books = await dbAll("SELECT * FROM books ORDER BY updated_at DESC");
  }
  books.forEach(b => b.coverColor = coverColorClass(b.id));
  res.render('index', { books, q, formatSize, showFav });
});

app.get('/book/add', (req, res) => {
  res.render('add', { errors: [], title: '', author: '', description: '' });
});

app.post('/book/add', (req, res) => {
  upload.single('file')(req, res, async (err) => {
    let title = (req.body.title || '').trim();
    const author = (req.body.author || '').trim();
    const description = (req.body.description || '').trim();
    const errors = [];

    if (err) { errors.push(err.message || '文件上传失败'); return res.render('add', { errors, title, author, description }); }
    // 书名留空则自动取文件名（不含扩展名）
    if (!title && req.file) {
      title = req.file.originalname.replace(/\.txt$/i, '');
    }
    if (!title) errors.push('书名不能为空');
    if (!req.file) errors.push('请选择要上传的 txt 文件');
    if (errors.length) return res.render('add', { errors, title, author, description });

    try {
      const buffer = IS_VERCEL ? req.file.buffer : fs.readFileSync(req.file.path);
      const identifier = await saveNovelFile(buffer, req.file.originalname);

      // Read content (pass identifier for both modes)
      const content = IS_VERCEL ? buffer.toString('utf-8') : readNovelFile(identifier);
      // Actually for Vercel we need to read content differently - buffer is already in memory
      let contentStr;
      if (IS_VERCEL) {
        // Try utf-8 first, fall back to gbk
        try { contentStr = buffer.toString('utf-8'); }
        catch { contentStr = buffer.toString('latin1'); }
      } else {
        contentStr = await readNovelFile(identifier);
      }

      const totalChars = countDisplayChars(contentStr);
      const pages = splitIntoPages(contentStr, CHARS_PER_PAGE);
      const fileSize = IS_VERCEL ? buffer.length : req.file.size;

      const result = await dbRun(
        `INSERT INTO books (title, author, description, filename, file_size, total_chars, total_pages) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [title, author, description, identifier, fileSize, totalChars, pages.length]
      );
      const bookId = result.lastInsertRowid;
      await dbRun('INSERT INTO reading_progress (book_id) VALUES (?)', [bookId]);

      res.redirect('/');
    } catch (e) {
      errors.push('保存失败: ' + e.message);
      res.render('add', { errors, title, author, description });
    }
  });
});

app.get('/book/:id/edit', async (req, res) => {
  const book = await dbGet('SELECT * FROM books WHERE id = ?', [req.params.id]);
  if (!book) return res.status(404).send('书籍不存在');
  res.render('edit', { book, errors: [] });
});

app.post('/book/:id/edit', async (req, res) => {
  const book = await dbGet('SELECT * FROM books WHERE id = ?', [req.params.id]);
  if (!book) return res.status(404).send('书籍不存在');

  const title = (req.body.title || '').trim();
  const author = (req.body.author || '').trim();
  const description = (req.body.description || '').trim();
  const errors = [];
  if (!title) errors.push('书名不能为空');
  if (errors.length) return res.render('edit', { book: { ...book, title, author, description }, errors });

  await dbRun("UPDATE books SET title=?, author=?, description=?, updated_at=datetime('now','localtime') WHERE id=?", [title, author, description, req.params.id]);
  res.redirect('/');
});

app.post('/book/:id/delete', async (req, res) => {
  const book = await dbGet('SELECT * FROM books WHERE id = ?', [req.params.id]);
  if (!book) return res.status(404).send('书籍不存在');

  await deleteNovelFile(book.filename);
  await dbRun('DELETE FROM books WHERE id = ?', [req.params.id]);
  res.redirect('/');
});

// -------------------------------------------------------------------------
// Routes – Reader
// -------------------------------------------------------------------------

app.get('/book/:id/read', async (req, res) => {
  const book = await dbGet('SELECT * FROM books WHERE id = ?', [req.params.id]);
  if (!book) return res.status(404).send('书籍不存在');
  const progress = await getOrCreateProgress(book.id);
  res.render('reader', { book, progress, totalPages: book.total_pages });
});

app.get('/api/book/:id/page/:pageNum', async (req, res) => {
  const book = await dbGet('SELECT * FROM books WHERE id = ?', [req.params.id]);
  if (!book) return res.status(404).json({ error: 'not found' });

  try {
    const content = await readNovelFile(book.filename);
    const pages = splitIntoPages(content, CHARS_PER_PAGE);
    const pageNum = parseInt(req.params.pageNum);
    if (pageNum < 1 || pageNum > pages.length) return res.status(404).json({ error: 'page out of range' });

    res.json({ page: pageNum, total_pages: pages.length, content: pages[pageNum - 1], title: book.title, author: book.author });
  } catch (e) {
    res.status(404).json({ error: 'file not found' });
  }
});

app.route('/api/book/:id/progress')
  .get(async (req, res) => {
    const book = await dbGet('SELECT * FROM books WHERE id = ?', [req.params.id]);
    if (!book) return res.status(404).json({ error: 'not found' });
    const progress = await getOrCreateProgress(book.id);
    res.json({ current_page: progress.current_page, font_size: progress.font_size, theme: progress.theme, total_pages: book.total_pages });
  })
  .post(async (req, res) => {
    const book = await dbGet('SELECT * FROM books WHERE id = ?', [req.params.id]);
    if (!book) return res.status(404).json({ error: 'not found' });

    const { current_page, font_size, theme } = req.body;
    const updates = [], params = [];
    if (current_page != null) { updates.push('current_page = ?'); params.push(parseInt(current_page)); }
    if (font_size != null) { updates.push('font_size = ?'); params.push(parseInt(font_size)); }
    if (theme != null) { updates.push('theme = ?'); params.push(theme); }
    if (updates.length) { params.push(req.params.id); await dbRun(`UPDATE reading_progress SET ${updates.join(', ')} WHERE book_id = ?`, params); }

    const progress = await getOrCreateProgress(book.id);
    res.json({ current_page: progress.current_page, font_size: progress.font_size, theme: progress.theme, total_pages: book.total_pages });
  });

// -------------------------------------------------------------------------
// Routes – Favorite & Rating
// -------------------------------------------------------------------------

/** POST /api/book/:id/favorite — Toggle favorite */
app.post('/api/book/:id/favorite', async (req, res) => {
  const book = await dbGet('SELECT * FROM books WHERE id = ?', [req.params.id]);
  if (!book) return res.status(404).json({ error: 'not found' });
  const newVal = book.is_favorite ? 0 : 1;
  await dbRun('UPDATE books SET is_favorite = ? WHERE id = ?', [newVal, req.params.id]);
  res.json({ id: book.id, is_favorite: newVal });
});

/** POST /api/book/:id/rating — Set rating (1-5, 0 to clear) */
app.post('/api/book/:id/rating', async (req, res) => {
  const book = await dbGet('SELECT * FROM books WHERE id = ?', [req.params.id]);
  if (!book) return res.status(404).json({ error: 'not found' });
  const rating = Math.max(0, Math.min(5, parseInt(req.body.rating) || 0));
  await dbRun('UPDATE books SET rating = ? WHERE id = ?', [rating, req.params.id]);
  res.json({ id: book.id, rating });
});

// -------------------------------------------------------------------------
// Vercel export / local listen
// -------------------------------------------------------------------------
module.exports = app;

if (!IS_VERCEL && require.main === module) {
  initDatabase().then(() => {
    global._dbReady = true;
    app.listen(PORT, '0.0.0.0', () => {
      console.log(` 🔖 小说管理站启动: http://127.0.0.1:${PORT}`);
    });
  });
}
