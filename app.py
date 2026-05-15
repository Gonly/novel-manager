#!/usr/bin/env python3
"""私有的小说管理网站 - Flask 后端"""

import os
import math
import shutil
from datetime import datetime

from flask import (
    Flask, render_template, request, redirect,
    url_for, jsonify, abort, send_from_directory
)

# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------
app = Flask(__name__)
app.config['UPLOAD_FOLDER'] = os.path.join(app.root_path, 'novels')
app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024  # 50 MB
app.config['CHARS_PER_PAGE'] = 2000  # 每页固定字数

# Ensure novels directory exists
os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)

# ---------------------------------------------------------------------------
# Database helpers (SQLite, no ORM)
# ---------------------------------------------------------------------------
import sqlite3

DB_PATH = os.path.join(app.root_path, 'database.db')


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    conn = get_db()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS books (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            title       TEXT    NOT NULL,
            author      TEXT    DEFAULT '',
            description TEXT    DEFAULT '',
            filename    TEXT    NOT NULL,
            file_size   INTEGER DEFAULT 0,
            total_chars INTEGER DEFAULT 0,
            total_pages INTEGER DEFAULT 0,
            created_at  TEXT    DEFAULT (datetime('now','localtime')),
            updated_at  TEXT    DEFAULT (datetime('now','localtime'))
        );
        CREATE TABLE IF NOT EXISTS reading_progress (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            book_id      INTEGER NOT NULL UNIQUE,
            current_page INTEGER DEFAULT 1,
            font_size    INTEGER DEFAULT 18,
            theme        TEXT    DEFAULT 'light',
            FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
        );
    """)
    conn.commit()
    conn.close()


init_db()

# ---------------------------------------------------------------------------
# Utility: count Chinese-friendly chars
# ---------------------------------------------------------------------------
def count_display_chars(text: str) -> int:
    """Count characters for pagination. Chinese chars = 1, ASCII = 0.5-ish.
    For simplicity we count every Unicode code point except newlines."""
    return len(text.replace('\n', '').replace('\r', ''))


def split_into_pages(text: str, chars_per_page: int) -> list[str]:
    """Split novel text into pages by character count (fixed width)."""
    # Remove \r, keep \n as part of content
    text = text.replace('\r\n', '\n').replace('\r', '\n')
    pages = []
    pos = 0
    total = len(text)
    while pos < total:
        end = min(pos + chars_per_page, total)
        # Try to break at a newline if we're not too far from the boundary
        if end < total:
            # look for nearest newline before end
            nl = text.rfind('\n', pos, end)
            if nl > pos and (end - nl) < chars_per_page * 0.3:
                end = nl + 1  # include the newline
        pages.append(text[pos:end])
        pos = end
    return pages


def get_book_filepath(book) -> str:
    return os.path.join(app.config['UPLOAD_FOLDER'], book['filename'])


def get_or_create_progress(conn, book_id: int) -> sqlite3.Row:
    cur = conn.execute(
        "SELECT * FROM reading_progress WHERE book_id = ?", (book_id,)
    )
    row = cur.fetchone()
    if row is None:
        conn.execute(
            "INSERT INTO reading_progress (book_id) VALUES (?)", (book_id,)
        )
        conn.commit()
        cur = conn.execute(
            "SELECT * FROM reading_progress WHERE book_id = ?", (book_id,)
        )
        row = cur.fetchone()
    return row


# ---------------------------------------------------------------------------
# Routes – Books CRUD
# ---------------------------------------------------------------------------

@app.route('/')
def index():
    """书库首页：列出所有书籍 + 搜索"""
    q = request.args.get('q', '').strip()
    conn = get_db()
    if q:
        rows = conn.execute(
            "SELECT * FROM books WHERE title LIKE ? OR author LIKE ? ORDER BY updated_at DESC",
            (f'%{q}%', f'%{q}%')
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM books ORDER BY updated_at DESC"
        ).fetchall()
    conn.close()
    return render_template('index.html', books=rows, q=q)


@app.route('/book/add', methods=['GET', 'POST'])
def add_book():
    """新增书籍"""
    if request.method == 'GET':
        return render_template('add.html')

    title = request.form.get('title', '').strip()
    author = request.form.get('author', '').strip()
    description = request.form.get('description', '').strip()
    file = request.files.get('file')

    errors = []
    if not title:
        errors.append('书名不能为空')
    if not file or file.filename == '':
        errors.append('请选择要上传的 txt 文件')
    elif not file.filename.lower().endswith('.txt'):
        errors.append('仅支持 .txt 文件')

    if errors:
        return render_template('add.html', errors=errors, title=title,
                               author=author, description=description)

    # Save uploaded file
    filename = f"{datetime.now().strftime('%Y%m%d%H%M%S')}_{file.filename}"
    filepath = os.path.join(app.config['UPLOAD_FOLDER'], filename)
    file.save(filepath)

    # Read content for pagination
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            content = f.read()
    except UnicodeDecodeError:
        # Try GBK for common Chinese encoding
        with open(filepath, 'r', encoding='gbk') as f:
            content = f.read()

    total_chars = count_display_chars(content)
    pages = split_into_pages(content, app.config['CHARS_PER_PAGE'])
    total_pages = len(pages)
    file_size = os.path.getsize(filepath)

    conn = get_db()
    conn.execute(
        """INSERT INTO books (title, author, description, filename,
           file_size, total_chars, total_pages)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (title, author, description, filename, file_size, total_chars, total_pages)
    )
    conn.commit()

    # Get the new book id and create progress entry
    book_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
    conn.execute("INSERT INTO reading_progress (book_id) VALUES (?)", (book_id,))
    conn.commit()
    conn.close()

    return redirect(url_for('index'))


@app.route('/book/<int:book_id>/edit', methods=['GET', 'POST'])
def edit_book(book_id):
    """编辑书籍信息"""
    conn = get_db()
    book = conn.execute("SELECT * FROM books WHERE id = ?", (book_id,)).fetchone()
    if not book:
        conn.close()
        abort(404)

    if request.method == 'GET':
        conn.close()
        return render_template('edit.html', book=book)

    title = request.form.get('title', '').strip()
    author = request.form.get('author', '').strip()
    description = request.form.get('description', '').strip()

    errors = []
    if not title:
        errors.append('书名不能为空')

    if errors:
        conn.close()
        return render_template('edit.html', book=book, errors=errors)

    conn.execute(
        "UPDATE books SET title=?, author=?, description=?, updated_at=datetime('now','localtime') WHERE id=?",
        (title, author, description, book_id)
    )
    conn.commit()
    conn.close()
    return redirect(url_for('index'))


@app.route('/book/<int:book_id>/delete', methods=['POST'])
def delete_book(book_id):
    """删除书籍（含文件）"""
    conn = get_db()
    book = conn.execute("SELECT * FROM books WHERE id = ?", (book_id,)).fetchone()
    if not book:
        conn.close()
        abort(404)

    # Delete txt file
    filepath = get_book_filepath(book)
    if os.path.exists(filepath):
        os.remove(filepath)

    # DB cascade will remove reading_progress
    conn.execute("DELETE FROM books WHERE id = ?", (book_id,))
    conn.commit()
    conn.close()
    return redirect(url_for('index'))


# ---------------------------------------------------------------------------
# Routes – Reader
# ---------------------------------------------------------------------------

@app.route('/book/<int:book_id>/read')
def reader(book_id):
    """阅读器页面"""
    conn = get_db()
    book = conn.execute("SELECT * FROM books WHERE id = ?", (book_id,)).fetchone()
    if not book:
        conn.close()
        abort(404)

    progress = get_or_create_progress(conn, book_id)
    conn.close()

    return render_template('reader.html', book=book, progress=progress,
                           total_pages=book['total_pages'])


@app.route('/api/book/<int:book_id>/page/<int:page_num>')
def get_page(book_id, page_num):
    """API：获取指定页的内容"""
    conn = get_db()
    book = conn.execute("SELECT * FROM books WHERE id = ?", (book_id,)).fetchone()
    if not book:
        conn.close()
        return jsonify({'error': 'not found'}), 404

    filepath = get_book_filepath(book)
    if not os.path.exists(filepath):
        conn.close()
        return jsonify({'error': 'file not found'}), 404

    # Read file (cache in memory in production? simple approach: read each time)
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            content = f.read()
    except UnicodeDecodeError:
        with open(filepath, 'r', encoding='gbk') as f:
            content = f.read()

    pages = split_into_pages(content, app.config['CHARS_PER_PAGE'])

    if page_num < 1 or page_num > len(pages):
        conn.close()
        return jsonify({'error': 'page out of range'}), 404

    page_text = pages[page_num - 1]
    total_pages = len(pages)

    # Compute approximate percentage
    book_title = book['title']
    book_author = book['author']

    conn.close()
    return jsonify({
        'page': page_num,
        'total_pages': total_pages,
        'content': page_text,
        'title': book_title,
        'author': book_author
    })


@app.route('/api/book/<int:book_id>/progress', methods=['GET', 'POST'])
def progress_api(book_id):
    """API：读写阅读进度"""
    conn = get_db()
    book = conn.execute("SELECT * FROM books WHERE id = ?", (book_id,)).fetchone()
    if not book:
        conn.close()
        return jsonify({'error': 'not found'}), 404

    if request.method == 'GET':
        progress = get_or_create_progress(conn, book_id)
        conn.close()
        return jsonify({
            'current_page': progress['current_page'],
            'font_size': progress['font_size'],
            'theme': progress['theme'],
            'total_pages': book['total_pages']
        })

    data = request.get_json() or {}
    current_page = data.get('current_page')
    font_size = data.get('font_size')
    theme = data.get('theme')

    updates = []
    params = []
    if current_page is not None:
        updates.append("current_page = ?")
        params.append(int(current_page))
    if font_size is not None:
        updates.append("font_size = ?")
        params.append(int(font_size))
    if theme is not None:
        updates.append("theme = ?")
        params.append(str(theme))

    if updates:
        sql = f"UPDATE reading_progress SET {', '.join(updates)} WHERE book_id = ?"
        params.append(book_id)
        conn.execute(sql, params)
        conn.commit()

    progress = get_or_create_progress(conn, book_id)
    conn.close()
    return jsonify({
        'current_page': progress['current_page'],
        'font_size': progress['font_size'],
        'theme': progress['theme'],
        'total_pages': book['total_pages']
    })


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
if __name__ == '__main__':
    print(" 🔖 小说管理站启动: http://127.0.0.1:5000")
    app.run(debug=True, host='0.0.0.0', port=5000)
