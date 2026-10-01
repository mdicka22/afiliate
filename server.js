const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const root = __dirname;
const port = Number(process.env.PORT || 3000);
const dataDir = process.env.AFFILINK_DATA_DIR || path.join(root, 'data');
const uploadDir = process.env.AFFILINK_UPLOAD_DIR || path.join(root, 'uploads');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(uploadDir, { recursive: true });
const db = new DatabaseSync(path.join(dataDir, 'affilink.sqlite'));
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
 id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
 slug TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, bio TEXT NOT NULL DEFAULT '',
 avatar_url TEXT NOT NULL DEFAULT '', theme TEXT NOT NULL DEFAULT 'editorial', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sessions (
 token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS collections (
 id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS products (
 id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', category TEXT NOT NULL,
 subcategory TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]', affiliate_url TEXT NOT NULL,
 image_url TEXT NOT NULL DEFAULT '', featured_rank INTEGER,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS collection_products (
 collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
 product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
 PRIMARY KEY(collection_id, product_id)
);
CREATE TABLE IF NOT EXISTS events (
 id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
 type TEXT NOT NULL CHECK(type IN ('visit','click','copy','share')),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS events_user_date ON events(user_id, created_at);
CREATE INDEX IF NOT EXISTS events_product_type ON events(product_id, type);
`);
if (!db.prepare("PRAGMA table_info(users)").all().some(column => column.name === 'theme')) db.exec("ALTER TABLE users ADD COLUMN theme TEXT NOT NULL DEFAULT 'editorial'");
const categories = JSON.parse(fs.readFileSync(path.join(root, 'categories.json'), 'utf8'));
const sessions = new Map();
const json = (res, status, value) => {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
};
const error = (res, status, message) => json(res, status, { error: message });
const clean = (v, max = 255) => String(v ?? '').trim().slice(0, max);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const passHash = password => { const salt = crypto.randomBytes(16).toString('hex'); return `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`; };
const passOk = (password, stored) => { try { const [salt, expected] = stored.split(':'); return crypto.timingSafeEqual(crypto.scryptSync(password, salt, 64), Buffer.from(expected, 'hex')); } catch { return false; } };
const cookie = req => Object.fromEntries((req.headers.cookie || '').split(';').map(v => v.trim().split('=').map(decodeURIComponent)).filter(v => v.length === 2));
const currentUser = req => {
  const token = cookie(req).affilink_session;
  if (!token) return null;
  const row = db.prepare('SELECT users.id, username, slug, display_name, bio, avatar_url, theme FROM sessions JOIN users ON users.id = sessions.user_id WHERE token_hash = ? AND expires_at > ?').get(hash(token), Date.now());
  return row || null;
};
const requireUser = (req, res) => { const user = currentUser(req); if (!user) error(res, 401, 'Silakan masuk terlebih dahulu.'); return user; };
const setSession = (res, userId) => {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(hash(token), userId, Date.now() + 30 * 86400000);
  res.setHeader('Set-Cookie', `affilink_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
};
const readBody = async req => {
  let bytes = 0, chunks = [];
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 4 * 1024 * 1024) throw new Error('Data terlalu besar.'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { throw new Error('Format data tidak valid.'); }
};
const publicUser = row => ({ id: row.id, username: row.username, slug: row.slug, displayName: row.display_name, bio: row.bio, avatarUrl: row.avatar_url, theme: row.theme || 'editorial' });
const productRow = row => ({ id: row.id, title: row.title, description: row.description, category: row.category, subcategory: row.subcategory, tags: JSON.parse(row.tags), affiliateUrl: row.affiliate_url, imageUrl: row.image_url, featuredRank: row.featured_rank, createdAt: row.created_at, clicks: row.clicks || 0, copies: row.copies || 0, shares: row.shares || 0, collectionIds: row.collection_ids ? row.collection_ids.split(',').map(Number) : [] });
const productsFor = userId => db.prepare(`SELECT p.*,
 (SELECT COUNT(*) FROM events e WHERE e.product_id=p.id AND e.type='click') clicks,
 (SELECT COUNT(*) FROM events e WHERE e.product_id=p.id AND e.type='copy') copies,
 (SELECT COUNT(*) FROM events e WHERE e.product_id=p.id AND e.type='share') shares,
 (SELECT GROUP_CONCAT(collection_id) FROM collection_products cp WHERE cp.product_id=p.id) collection_ids
 FROM products p WHERE p.user_id=? ORDER BY p.created_at DESC, p.id DESC`).all(userId).map(productRow);
const collectionsFor = userId => db.prepare('SELECT id,name,description,created_at FROM collections WHERE user_id=? ORDER BY created_at DESC,id DESC').all(userId).map(c => ({ id: c.id, name: c.name, description: c.description, createdAt: c.created_at }));
const validUrl = value => { try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !!url.hostname; } catch { return false; } };
const reserved = new Set(['app','auth','login','register','api','uploads','assets','favicon.ico','demo','admin','www']);
const validSlug = value => /^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])?$/.test(value) && !reserved.has(value);
const event = (userId, productId, type) => db.prepare('INSERT INTO events(user_id,product_id,type) VALUES(?,?,?)').run(userId, productId, type);
const rate = (req, key, limit, interval) => {
  const id = `${req.socket.remoteAddress}:${key}`, now = Date.now();
  const old = sessions.get(id) || [];
  const recent = old.filter(t => now - t < interval);
  if (recent.length >= limit) return false;
  recent.push(now); sessions.set(id, recent);
  return true;
};
const sendFile = (res, file, type) => {
  fs.readFile(file, (err, body) => { if (err) return error(res, 404, 'Tidak ditemukan.'); res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': type.startsWith('image/') ? 'public, max-age=86400' : 'no-cache' }); res.end(body); });
};

async function api(req, res, url) {
  const route = url.pathname;
  const method = req.method;
  if (route === '/api/categories' && method === 'GET') return json(res, 200, categories);
  if (route === '/api/me' && method === 'GET') { const u = currentUser(req); return json(res, 200, { user: u ? publicUser(u) : null }); }
  if (route === '/api/slug-check' && method === 'GET') {
    const slug = clean(url.searchParams.get('slug'), 32).toLowerCase();
    return json(res, 200, { available: validSlug(slug) && !db.prepare('SELECT id FROM users WHERE slug=?').get(slug) });
  }
  if (route === '/api/register' && method === 'POST') {
    if (!rate(req, 'register', 8, 3600000)) return error(res, 429, 'Terlalu banyak percobaan. Coba lagi nanti.');
    const body = await readBody(req), username = clean(body.username, 32).toLowerCase(), slug = clean(body.slug, 32).toLowerCase();
    const displayName = clean(body.displayName, 60), password = String(body.password || '');
    if (!/^[a-z0-9_]{3,24}$/.test(username)) return error(res, 400, 'Username harus 3–24 karakter: huruf kecil, angka, atau garis bawah.');
    if (!validSlug(slug)) return error(res, 400, 'Nama link harus 3–30 karakter: huruf kecil, angka, atau tanda hubung.');
    if (!displayName) return error(res, 400, 'Nama tampilan wajib diisi.');
    if (password.length < 8 || password.length > 128) return error(res, 400, 'Password minimal 8 karakter.');
    if (db.prepare('SELECT id FROM users WHERE username=? OR slug=?').get(username, slug)) return error(res, 409, 'Username atau link tidak tersedia.');
    const result = db.prepare('INSERT INTO users(username,password_hash,slug,display_name) VALUES(?,?,?,?)').run(username, passHash(password), slug, displayName);
    setSession(res, Number(result.lastInsertRowid));
    return json(res, 201, { user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(Number(result.lastInsertRowid))) });
  }
  if (route === '/api/login' && method === 'POST') {
    if (!rate(req, 'login', 12, 15 * 60000)) return error(res, 429, 'Terlalu banyak percobaan. Coba lagi nanti.');
    const body = await readBody(req), username = clean(body.username, 32).toLowerCase();
    const row = db.prepare('SELECT * FROM users WHERE username=?').get(username);
    if (!row || !passOk(String(body.password || ''), row.password_hash)) return error(res, 401, 'Username atau password salah.');
    setSession(res, row.id); return json(res, 200, { user: publicUser(row) });
  }
  if (route === '/api/logout' && method === 'POST') {
    const token = cookie(req).affilink_session;
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(token));
    res.setHeader('Set-Cookie', 'affilink_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    return json(res, 200, { ok: true });
  }
  const pub = route.match(/^\/api\/public\/([a-z0-9-]+)$/);
  if (pub && method === 'GET') {
    const user = db.prepare('SELECT id,username,slug,display_name,bio,avatar_url,theme FROM users WHERE slug=?').get(pub[1]);
    if (!user) return error(res, 404, 'Halaman tidak ditemukan.');
    if (rate(req, `visit:${user.id}`, 1, 30000)) event(user.id, null, 'visit');
    return json(res, 200, { user: publicUser(user), products: productsFor(user.id), collections: collectionsFor(user.id) });
  }
  const track = route.match(/^\/api\/public\/([a-z0-9-]+)\/products\/(\d+)\/(click|copy|share)$/);
  if (track && method === 'POST') {
    if (!rate(req, `event:${track[2]}`, 30, 60000)) return error(res, 429, 'Terlalu banyak permintaan.');
    const product = db.prepare('SELECT p.id,p.user_id FROM products p JOIN users u ON u.id=p.user_id WHERE p.id=? AND u.slug=?').get(Number(track[2]), track[1]);
    if (!product) return error(res, 404, 'Produk tidak ditemukan.');
    event(product.user_id, product.id, track[3]); return json(res, 200, { ok: true });
  }
  const user = requireUser(req, res); if (!user) return;
  if (route === '/api/dashboard' && method === 'GET') {
    const totals = db.prepare(`SELECT
      SUM(type='visit') visits, SUM(type='click') clicks, SUM(type='copy') copies, SUM(type='share') shares
      FROM events WHERE user_id=?`).get(user.id);
    const daily = db.prepare(`SELECT substr(created_at,1,10) day, COUNT(*) count FROM events WHERE user_id=? AND type='visit' AND created_at >= datetime('now','-6 days') GROUP BY day ORDER BY day`).all(user.id);
    return json(res, 200, { user: publicUser(user), products: productsFor(user.id), collections: collectionsFor(user.id), stats: { visits: totals.visits || 0, clicks: totals.clicks || 0, copies: totals.copies || 0, shares: totals.shares || 0, daily } });
  }
  if (route === '/api/profile' && method === 'PUT') {
    const body = await readBody(req), slug = clean(body.slug, 32).toLowerCase(), displayName = clean(body.displayName, 60), bio = clean(body.bio, 280), avatarUrl = clean(body.avatarUrl, 2048), theme = clean(body.theme || 'editorial', 20);
    if (!validSlug(slug)) return error(res, 400, 'Format link tidak valid.');
    if (!displayName) return error(res, 400, 'Nama tampilan wajib diisi.');
    if (!['editorial','blush','studio'].includes(theme)) return error(res, 400, 'Tema halaman tidak valid.');
    if (avatarUrl && !validUrl(avatarUrl) && !avatarUrl.startsWith('/uploads/')) return error(res, 400, 'URL foto tidak valid.');
    const used = db.prepare('SELECT id FROM users WHERE slug=? AND id<>?').get(slug, user.id);
    if (used) return error(res, 409, 'Link tidak tersedia.');
    db.prepare('UPDATE users SET slug=?,display_name=?,bio=?,avatar_url=?,theme=? WHERE id=?').run(slug, displayName, bio, avatarUrl, theme, user.id);
    return json(res, 200, { user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(user.id)) });
  }
  if (route === '/api/upload' && method === 'POST') {
    const body = await readBody(req), match = String(body.data || '').match(/^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/);
    if (!match) return error(res, 400, 'Pilih gambar PNG, JPG, WebP, atau GIF.');
    const buffer = Buffer.from(match[2], 'base64');
    if (buffer.length > 2 * 1024 * 1024 || buffer.length < 12) return error(res, 400, 'Ukuran gambar maksimal 2 MB.');
    const signatures = { png: buffer.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')), jpeg: buffer.subarray(0,3).equals(Buffer.from('ffd8ff','hex')), webp: buffer.toString('ascii',0,4)==='RIFF' && buffer.toString('ascii',8,12)==='WEBP', gif: buffer.toString('ascii',0,3)==='GIF' };
    if (!signatures[match[1]]) return error(res, 400, 'Berkas gambar tidak valid.');
    const ext = { jpeg: 'jpg', png: 'png', webp: 'webp', gif: 'gif' }[match[1]], filename = `${crypto.randomUUID()}.${ext}`;
    fs.writeFileSync(path.join(uploadDir, filename), buffer);
    return json(res, 201, { url: `/uploads/${filename}` });
  }
  if (route === '/api/collections' && method === 'POST') {
    const body = await readBody(req), name = clean(body.name, 80), description = clean(body.description, 280);
    if (!name) return error(res, 400, 'Nama koleksi wajib diisi.');
    const result = db.prepare('INSERT INTO collections(user_id,name,description) VALUES(?,?,?)').run(user.id, name, description);
    return json(res, 201, { id: Number(result.lastInsertRowid) });
  }
  const collectionRoute = route.match(/^\/api\/collections\/(\d+)$/);
  if (collectionRoute && ['PUT','DELETE'].includes(method)) {
    const id = Number(collectionRoute[1]), found = db.prepare('SELECT id FROM collections WHERE id=? AND user_id=?').get(id,user.id);
    if (!found) return error(res, 404, 'Koleksi tidak ditemukan.');
    if (method === 'DELETE') { db.prepare('DELETE FROM collections WHERE id=?').run(id); return json(res, 200, { ok: true }); }
    const body = await readBody(req), name = clean(body.name,80), description = clean(body.description,280);
    if (!name) return error(res,400,'Nama koleksi wajib diisi.');
    db.prepare('UPDATE collections SET name=?,description=? WHERE id=?').run(name,description,id);
    return json(res,200,{ ok:true });
  }
  if (route === '/api/products' && method === 'POST') return saveProduct(req,res,user.id,null);
  const productRoute = route.match(/^\/api\/products\/(\d+)$/);
  if (productRoute && ['PUT','DELETE'].includes(method)) {
    const id = Number(productRoute[1]), found = db.prepare('SELECT id FROM products WHERE id=? AND user_id=?').get(id,user.id);
    if (!found) return error(res,404,'Produk tidak ditemukan.');
    if (method === 'DELETE') { db.prepare('DELETE FROM products WHERE id=?').run(id); return json(res,200,{ ok:true }); }
    return saveProduct(req,res,user.id,id);
  }
  return error(res,404,'Alamat API tidak ditemukan.');
}

async function saveProduct(req,res,userId,id) {
  const isNew = !id;
  const body = await readBody(req);
  const title = clean(body.title,120), description = clean(body.description,600), category = clean(body.category,80), subcategory = clean(body.subcategory,80), affiliateUrl = clean(body.affiliateUrl,2048), imageUrl = clean(body.imageUrl,2048);
  const tags = Array.isArray(body.tags) ? [...new Set(body.tags.map(t => clean(t,30).toLowerCase()).filter(Boolean))].slice(0,12) : [];
  const featuredRank = body.featuredRank === null || body.featuredRank === '' || body.featuredRank === undefined ? null : Number(body.featuredRank);
  const collectionIds = Array.isArray(body.collectionIds) ? [...new Set(body.collectionIds.map(Number).filter(Number.isInteger))] : [];
  if (!title || !category || !subcategory || !affiliateUrl) return error(res,400,'Lengkapi nama, kategori, subkategori, dan link produk.');
  if (!categories[category] || !categories[category].includes(subcategory)) return error(res,400,'Kategori atau subkategori tidak valid.');
  if (!validUrl(affiliateUrl)) return error(res,400,'Link produk harus memakai http atau https.');
  if (imageUrl && !validUrl(imageUrl) && !/^\/uploads\/[a-f0-9-]+\.(png|jpg|webp|gif)$/.test(imageUrl)) return error(res,400,'URL gambar tidak valid.');
  if (featuredRank !== null && (!Number.isInteger(featuredRank) || featuredRank < 1 || featuredRank > 999)) return error(res,400,'Urutan rekomendasi harus 1–999.');
  if (collectionIds.some(cid => !db.prepare('SELECT id FROM collections WHERE id=? AND user_id=?').get(cid,userId))) return error(res,400,'Koleksi tidak valid.');
  db.exec('BEGIN');
  try {
    if (id) db.prepare('UPDATE products SET title=?,description=?,category=?,subcategory=?,tags=?,affiliate_url=?,image_url=?,featured_rank=? WHERE id=? AND user_id=?').run(title,description,category,subcategory,JSON.stringify(tags),affiliateUrl,imageUrl,featuredRank,id,userId);
    else id = Number(db.prepare('INSERT INTO products(user_id,title,description,category,subcategory,tags,affiliate_url,image_url,featured_rank) VALUES(?,?,?,?,?,?,?,?,?)').run(userId,title,description,category,subcategory,JSON.stringify(tags),affiliateUrl,imageUrl,featuredRank).lastInsertRowid);
    db.prepare('DELETE FROM collection_products WHERE product_id=?').run(id);
    for (const cid of collectionIds) db.prepare('INSERT INTO collection_products(collection_id,product_id) VALUES(?,?)').run(cid,id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return json(res, isNew ? 201 : 200, { id });
}

const server = http.createServer(async (req,res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (!['GET','HEAD'].includes(req.method)) {
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) return error(res,403,'Permintaan lintas situs ditolak.');
    }
    if (url.pathname.startsWith('/api/')) return await api(req,res,url);
    if (url.pathname.startsWith('/uploads/')) {
      const name = path.basename(url.pathname);
      if (name !== url.pathname.slice(9) || !/^[a-f0-9-]+\.(png|jpg|webp|gif)$/.test(name)) return error(res,404,'Tidak ditemukan.');
      const ext = path.extname(name).slice(1); return sendFile(res,path.join(uploadDir,name),{jpg:'image/jpeg',png:'image/png',webp:'image/webp',gif:'image/gif'}[ext]);
    }
    const assets = { '/styles.css': 'text/css; charset=utf-8', '/redesign.css': 'text/css; charset=utf-8', '/refresh.css': 'text/css; charset=utf-8', '/polish.css': 'text/css; charset=utf-8', '/app.js': 'text/javascript; charset=utf-8', '/favicon.svg': 'image/svg+xml', '/assets/affalink-3d.png': 'image/png', '/assets/creator-demo.png': 'image/png', '/assets/serum-demo.png': 'image/png' };
    if (assets[url.pathname]) return sendFile(res,path.join(root,'public',url.pathname),assets[url.pathname]);
    if (url.pathname === '/' || url.pathname === '/app' || url.pathname === '/auth' || /^\/[a-z0-9-]+\/?$/.test(url.pathname)) return sendFile(res,path.join(root,'public','index.html'),'text/html; charset=utf-8');
    return error(res,404,'Halaman tidak ditemukan.');
  } catch (e) {
    if (!res.headersSent) error(res,e.message === 'Data terlalu besar.' || e.message === 'Format data tidak valid.' ? 400 : 500, e.message === 'Data terlalu besar.' || e.message === 'Format data tidak valid.' ? e.message : 'Terjadi kesalahan server.');
    console.error(e);
  }
});
if (require.main === module) server.listen(port, () => console.log(`Affilink berjalan di http://localhost:${port}`));
module.exports = server;
