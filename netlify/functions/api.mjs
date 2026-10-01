import crypto from 'node:crypto';
import pg from 'pg';
import categories from '../../categories.json' with { type: 'json' };

let livePool;
const limits = new Map();
const reserved = new Set(['app','auth','login','register','api','uploads','assets','favicon.ico','demo','admin','www']);
export const databasePoolConfig = (connectionString, caCertificate = '') => {
  const url = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('SUPABASE_DB_URL harus berupa URL PostgreSQL.');
  // node-postgres lets sslmode in the URL override the ssl object below.
  for (const key of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey']) url.searchParams.delete(key);
  const ca = caCertificate.trim().replace(/\\n/g, '\n');
  if (ca && !/^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----\s*$/.test(ca)) throw new Error('SUPABASE_DB_CA bukan sertifikat PEM yang valid.');
  return {
    connectionString: url.toString(),
    max: 1,
    ssl: ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: false },
    connectionTimeoutMillis: 8000,
    idleTimeoutMillis: 10000,
  };
};
const getPool = () => {
  if (!process.env.SUPABASE_DB_URL) throw new Error('SUPABASE_DB_URL belum diatur.');
  return livePool ||= new pg.Pool(databasePoolConfig(process.env.SUPABASE_DB_URL, process.env.SUPABASE_DB_CA));
};
const uploadToSupabase = async (name, bytes, contentType) => {
  const baseUrl = process.env.SUPABASE_URL?.replace(/\/$/, '');
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (!baseUrl || !secret) throw new Error('SUPABASE_URL atau SUPABASE_SECRET_KEY belum diatur.');
  const objectUrl = `${baseUrl}/storage/v1/object/product-images/${encodeURIComponent(name)}`;
  const response = await fetch(objectUrl, { method: 'POST', headers: { apikey: secret, 'Content-Type': contentType, 'x-upsert': 'false' }, body: bytes });
  if (!response.ok) throw new Error(`Supabase Storage upload gagal: ${response.status}`);
  return `${baseUrl}/storage/v1/object/public/product-images/${encodeURIComponent(name)}`;
};
const clean = (value, max = 255) => String(value ?? '').trim().slice(0, max);
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const passwordHash = password => { const salt = crypto.randomBytes(16).toString('hex'); return `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`; };
const passwordOk = (password, stored) => { try { const [salt, expected] = stored.split(':'); return crypto.timingSafeEqual(crypto.scryptSync(password, salt, 64), Buffer.from(expected, 'hex')); } catch { return false; } };
const validUrl = value => { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !!url.hostname; } catch { return false; } };
const validSlug = value => /^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])?$/.test(value) && !reserved.has(value);
const json = (value, status = 200, headers = {}) => Response.json(value, { status, headers: { 'Cache-Control':'no-store', ...headers } });
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new HttpError(status, message); };
const cookieValue = (request, key) => (request.headers.get('cookie') || '').split(';').map(x => x.trim()).find(x => x.startsWith(`${key}=`))?.slice(key.length + 1);
const sessionCookie = (token, secure, maxAge = 2592000) => `affilink_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
const userView = row => ({ id:row.id, username:row.username, slug:row.slug, displayName:row.display_name, bio:row.bio, avatarUrl:row.avatar_url, theme:row.theme || 'editorial' });
const productView = row => ({ id:row.id, title:row.title, description:row.description, category:row.category, subcategory:row.subcategory, tags:row.tags, affiliateUrl:row.affiliate_url, imageUrl:row.image_url, featuredRank:row.featured_rank, createdAt:row.created_at, clicks:row.clicks, copies:row.copies, shares:row.shares, collectionIds:row.collection_ids });
const collectionView = row => ({ id:row.id, name:row.name, description:row.description, createdAt:row.created_at });
const readBody = async request => {
  if (Number(request.headers.get('content-length') || 0) > 4 * 1024 * 1024) fail(400, 'Data terlalu besar.');
  const raw = await request.text();
  if (Buffer.byteLength(raw) > 4 * 1024 * 1024) fail(400, 'Data terlalu besar.');
  try { return JSON.parse(raw || '{}'); } catch { fail(400, 'Format data tidak valid.'); }
};
const rate = (request, key, count, interval) => {
  const now = Date.now();
  const ip = request.headers.get('x-nf-client-connection-ip') || request.headers.get('x-forwarded-for')?.split(',')[0] || 'unknown';
  const id = `${ip}:${key}`;
  const times = (limits.get(id) || []).filter(time => now - time < interval);
  if (times.length >= count) return false;
  times.push(now); limits.set(id, times);
  return true;
};

export function createHandler({ pool, uploadImage = uploadToSupabase }) {
  const rows = async (sql, args = []) => (await pool.query(sql, args)).rows;
  const one = async (sql, args = []) => (await rows(sql, args))[0] || null;
  const currentUser = async request => {
    const token = cookieValue(request, 'affilink_session');
    return token ? one(`SELECT u.id,u.username,u.slug,u.display_name,u.bio,u.avatar_url,u.theme FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>$2`, [digest(token), Date.now()]) : null;
  };
  const requireUser = async request => await currentUser(request) || fail(401, 'Silakan masuk terlebih dahulu.');
  const makeSession = async (userId, secure) => {
    const token = crypto.randomBytes(32).toString('hex');
    await pool.query('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)', [digest(token), userId, Date.now() + 30 * 86400000]);
    return sessionCookie(token, secure);
  };
  const productsFor = async userId => (await rows(`SELECT p.*,
    (SELECT COUNT(*)::int FROM events e WHERE e.product_id=p.id AND e.type='click') clicks,
    (SELECT COUNT(*)::int FROM events e WHERE e.product_id=p.id AND e.type='copy') copies,
    (SELECT COUNT(*)::int FROM events e WHERE e.product_id=p.id AND e.type='share') shares,
    COALESCE((SELECT array_agg(cp.collection_id ORDER BY cp.collection_id) FROM collection_products cp WHERE cp.product_id=p.id), ARRAY[]::integer[]) collection_ids
    FROM products p WHERE p.user_id=$1 ORDER BY p.created_at DESC,p.id DESC`, [userId])).map(productView);
  const collectionsFor = async userId => (await rows('SELECT id,name,description,created_at FROM collections WHERE user_id=$1 ORDER BY created_at DESC,id DESC', [userId])).map(collectionView);
  const addEvent = (userId, productId, type) => pool.query('INSERT INTO events(user_id,product_id,type) VALUES($1,$2,$3)', [userId, productId, type]);
  const saveProduct = async (request, userId, id) => {
    const isNew = !id;
    const body = await readBody(request);
    const title = clean(body.title,120), description = clean(body.description,600), category = clean(body.category,80), subcategory = clean(body.subcategory,80), affiliateUrl = clean(body.affiliateUrl,2048), imageUrl = clean(body.imageUrl,2048);
    const tags = Array.isArray(body.tags) ? [...new Set(body.tags.map(t => clean(t,30).toLowerCase()).filter(Boolean))].slice(0,12) : [];
    const featuredRank = body.featuredRank === null || body.featuredRank === '' || body.featuredRank === undefined ? null : Number(body.featuredRank);
    const collectionIds = Array.isArray(body.collectionIds) ? [...new Set(body.collectionIds.map(Number).filter(Number.isInteger))] : [];
    if (!title || !category || !subcategory || !affiliateUrl) fail(400, 'Lengkapi nama, kategori, subkategori, dan link produk.');
    if (!categories[category] || !categories[category].includes(subcategory)) fail(400, 'Kategori atau subkategori tidak valid.');
    if (!validUrl(affiliateUrl)) fail(400, 'Link produk harus memakai http atau https.');
    if (imageUrl && !validUrl(imageUrl) && !/^\/uploads\/[a-f0-9-]+\.(png|jpg|webp|gif)$/.test(imageUrl)) fail(400, 'URL gambar tidak valid.');
    if (featuredRank !== null && (!Number.isInteger(featuredRank) || featuredRank < 1 || featuredRank > 999)) fail(400, 'Urutan rekomendasi harus 1–999.');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (collectionIds.length) {
        const valid = await client.query('SELECT COUNT(*)::int AS n FROM collections WHERE user_id=$1 AND id=ANY($2::integer[])', [userId, collectionIds]);
        if (valid.rows[0].n !== collectionIds.length) fail(400, 'Koleksi tidak valid.');
      }
      if (id) {
        const result = await client.query('UPDATE products SET title=$1,description=$2,category=$3,subcategory=$4,tags=$5::jsonb,affiliate_url=$6,image_url=$7,featured_rank=$8 WHERE id=$9 AND user_id=$10 RETURNING id', [title,description,category,subcategory,JSON.stringify(tags),affiliateUrl,imageUrl,featuredRank,id,userId]);
        if (!result.rowCount) fail(404, 'Produk tidak ditemukan.');
      } else {
        const result = await client.query('INSERT INTO products(user_id,title,description,category,subcategory,tags,affiliate_url,image_url,featured_rank) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9) RETURNING id', [userId,title,description,category,subcategory,JSON.stringify(tags),affiliateUrl,imageUrl,featuredRank]);
        id = result.rows[0].id;
      }
      await client.query('DELETE FROM collection_products WHERE product_id=$1', [id]);
      for (const collectionId of collectionIds) await client.query('INSERT INTO collection_products(collection_id,product_id) VALUES($1,$2)', [collectionId,id]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    return json({ id }, isNew ? 201 : 200);
  };

  return async request => {
    try {
      const url = new URL(request.url);
      const route = url.pathname.replace(/^\/\.netlify\/functions\/api/, '/api');
      const method = request.method;
      if (!['GET','HEAD'].includes(method)) {
        const origin = request.headers.get('origin');
        if (origin && new URL(origin).host !== url.host) fail(403, 'Permintaan lintas situs ditolak.');
      }
      if (route === '/api/categories' && method === 'GET') return json(categories);
      if (route === '/api/me' && method === 'GET') { const user = await currentUser(request); return json({ user:user ? userView(user) : null }); }
      if (route === '/api/slug-check' && method === 'GET') {
        const slug = clean(url.searchParams.get('slug'),32).toLowerCase();
        return json({ available:validSlug(slug) && !(await one('SELECT id FROM users WHERE slug=$1',[slug])) });
      }
      if (route === '/api/register' && method === 'POST') {
        if (!rate(request,'register',8,3600000)) fail(429,'Terlalu banyak percobaan. Coba lagi nanti.');
        const body = await readBody(request), username = clean(body.username,32).toLowerCase(), slug = clean(body.slug,32).toLowerCase();
        const displayName = clean(body.displayName,60), password = String(body.password || '');
        if (!/^[a-z0-9_]{3,24}$/.test(username)) fail(400,'Username harus 3–24 karakter: huruf kecil, angka, atau garis bawah.');
        if (!validSlug(slug)) fail(400,'Nama link harus 3–30 karakter: huruf kecil, angka, atau tanda hubung.');
        if (!displayName) fail(400,'Nama tampilan wajib diisi.');
        if (password.length < 8 || password.length > 128) fail(400,'Password minimal 8 karakter.');
        if (await one('SELECT id FROM users WHERE username=$1 OR slug=$2',[username,slug])) fail(409,'Username atau link tidak tersedia.');
        const user = await one('INSERT INTO users(username,password_hash,slug,display_name) VALUES($1,$2,$3,$4) RETURNING id,username,slug,display_name,bio,avatar_url',[username,passwordHash(password),slug,displayName]);
        return json({ user:userView(user) },201,{ 'Set-Cookie':await makeSession(user.id,url.protocol==='https:') });
      }
      if (route === '/api/login' && method === 'POST') {
        if (!rate(request,'login',12,15*60000)) fail(429,'Terlalu banyak percobaan. Coba lagi nanti.');
        const body = await readBody(request), username = clean(body.username,32).toLowerCase();
        const user = await one('SELECT * FROM users WHERE username=$1',[username]);
        if (!user || !passwordOk(String(body.password || ''),user.password_hash)) fail(401,'Username atau password salah.');
        return json({ user:userView(user) },200,{ 'Set-Cookie':await makeSession(user.id,url.protocol==='https:') });
      }
      if (route === '/api/logout' && method === 'POST') {
        const token = cookieValue(request,'affilink_session');
        if (token) await pool.query('DELETE FROM sessions WHERE token_hash=$1',[digest(token)]);
        return json({ ok:true },200,{ 'Set-Cookie':sessionCookie('',url.protocol==='https:',0) });
      }
      const publicMatch = route.match(/^\/api\/public\/([a-z0-9-]+)$/);
      if (publicMatch && method === 'GET') {
        const user = await one('SELECT id,username,slug,display_name,bio,avatar_url,theme FROM users WHERE slug=$1',[publicMatch[1]]);
        if (!user) fail(404,'Halaman tidak ditemukan.');
        if (rate(request,`visit:${user.id}`,1,30000)) await addEvent(user.id,null,'visit');
        return json({ user:userView(user), products:await productsFor(user.id), collections:await collectionsFor(user.id) });
      }
      const track = route.match(/^\/api\/public\/([a-z0-9-]+)\/products\/(\d+)\/(click|copy|share)$/);
      if (track && method === 'POST') {
        if (!rate(request,`event:${track[2]}`,30,60000)) fail(429,'Terlalu banyak permintaan.');
        const product = await one('SELECT p.id,p.user_id FROM products p JOIN users u ON u.id=p.user_id WHERE p.id=$1 AND u.slug=$2',[Number(track[2]),track[1]]);
        if (!product) fail(404,'Produk tidak ditemukan.');
        await addEvent(product.user_id,product.id,track[3]); return json({ ok:true });
      }
      const user = await requireUser(request);
      if (route === '/api/dashboard' && method === 'GET') {
        const totals = await one(`SELECT COUNT(*) FILTER (WHERE type='visit')::int visits, COUNT(*) FILTER (WHERE type='click')::int clicks, COUNT(*) FILTER (WHERE type='copy')::int copies, COUNT(*) FILTER (WHERE type='share')::int shares FROM events WHERE user_id=$1`,[user.id]);
        const daily = await rows(`SELECT TO_CHAR(created_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS "day", COUNT(*)::int AS "count" FROM events WHERE user_id=$1 AND type='visit' AND created_at >= NOW() - INTERVAL '6 days' GROUP BY 1 ORDER BY 1`,[user.id]);
        return json({ user:userView(user), products:await productsFor(user.id), collections:await collectionsFor(user.id), stats:{ ...totals,daily } });
      }
      if (route === '/api/profile' && method === 'PUT') {
        const body = await readBody(request), slug = clean(body.slug,32).toLowerCase(), displayName = clean(body.displayName,60), bio = clean(body.bio,280), avatarUrl = clean(body.avatarUrl,2048), theme = clean(body.theme || 'editorial',20);
        if (!validSlug(slug)) fail(400,'Format link tidak valid.');
        if (!displayName) fail(400,'Nama tampilan wajib diisi.');
        if (!['editorial','blush','studio'].includes(theme)) fail(400,'Tema halaman tidak valid.');
        if (avatarUrl && !validUrl(avatarUrl) && !avatarUrl.startsWith('/uploads/')) fail(400,'URL foto tidak valid.');
        if (await one('SELECT id FROM users WHERE slug=$1 AND id<>$2',[slug,user.id])) fail(409,'Link tidak tersedia.');
        const updated = await one('UPDATE users SET slug=$1,display_name=$2,bio=$3,avatar_url=$4,theme=$5 WHERE id=$6 RETURNING id,username,slug,display_name,bio,avatar_url,theme',[slug,displayName,bio,avatarUrl,theme,user.id]);
        return json({ user:userView(updated) });
      }
      if (route === '/api/upload' && method === 'POST') {
        const body = await readBody(request), match = String(body.data || '').match(/^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/);
        if (!match) fail(400,'Pilih gambar PNG, JPG, WebP, atau GIF.');
        const buffer = Buffer.from(match[2],'base64');
        if (buffer.length > 2*1024*1024 || buffer.length < 12) fail(400,'Ukuran gambar maksimal 2 MB.');
        const signatures = { png:buffer.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')), jpeg:buffer.subarray(0,3).equals(Buffer.from('ffd8ff','hex')), webp:buffer.toString('ascii',0,4)==='RIFF' && buffer.toString('ascii',8,12)==='WEBP', gif:buffer.toString('ascii',0,3)==='GIF' };
        if (!signatures[match[1]]) fail(400,'Berkas gambar tidak valid.');
        const ext = {jpeg:'jpg',png:'png',webp:'webp',gif:'gif'}[match[1]], name = `${crypto.randomUUID()}.${ext}`;
        const uploadedUrl = await uploadImage(name,buffer,`image/${match[1]}`);
        return json({ url:uploadedUrl },201);
      }
      if (route === '/api/collections' && method === 'POST') {
        const body = await readBody(request), name = clean(body.name,80), description = clean(body.description,280);
        if (!name) fail(400,'Nama koleksi wajib diisi.');
        const item = await one('INSERT INTO collections(user_id,name,description) VALUES($1,$2,$3) RETURNING id',[user.id,name,description]);
        return json({ id:item.id },201);
      }
      const collectionMatch = route.match(/^\/api\/collections\/(\d+)$/);
      if (collectionMatch && ['PUT','DELETE'].includes(method)) {
        const id = Number(collectionMatch[1]);
        if (method === 'DELETE') {
          const result = await pool.query('DELETE FROM collections WHERE id=$1 AND user_id=$2',[id,user.id]);
          if (!result.rowCount) fail(404,'Koleksi tidak ditemukan.');
          return json({ ok:true });
        }
        const body = await readBody(request), name = clean(body.name,80), description = clean(body.description,280);
        if (!name) fail(400,'Nama koleksi wajib diisi.');
        const result = await pool.query('UPDATE collections SET name=$1,description=$2 WHERE id=$3 AND user_id=$4',[name,description,id,user.id]);
        if (!result.rowCount) fail(404,'Koleksi tidak ditemukan.');
        return json({ ok:true });
      }
      if (route === '/api/products' && method === 'POST') return await saveProduct(request,user.id,null);
      const productMatch = route.match(/^\/api\/products\/(\d+)$/);
      if (productMatch && ['PUT','DELETE'].includes(method)) {
        const id = Number(productMatch[1]);
        if (method === 'DELETE') {
          const result = await pool.query('DELETE FROM products WHERE id=$1 AND user_id=$2',[id,user.id]);
          if (!result.rowCount) fail(404,'Produk tidak ditemukan.');
          return json({ ok:true });
        }
        return await saveProduct(request,user.id,id);
      }
      fail(404,'Alamat API tidak ditemukan.');
    } catch (error) {
      if (error instanceof HttpError) return json({ error:error.message },error.status);
      if (error?.code === '23505') return json({ error:'Username atau link tidak tersedia.' },409);
      console.error('Affilink API error',error);
      return json({ error:'Terjadi kesalahan server.' },500);
    }
  };
}

let themeMigration;
export default async function handler(request) {
  const pool = getPool();
  themeMigration ||= pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS theme VARCHAR(20) NOT NULL DEFAULT 'editorial'").catch(error => { themeMigration = null; throw error; });
  await themeMigration;
  return createHandler({ pool })(request);
}
