import crypto from 'node:crypto';
import { upgrade, durableRate, accountRoutes, hasAccess, isAdmin } from './lib/accounts.mjs';
import pg from 'pg';
import categories from '../../categories.json' with { type: 'json' };

let livePool;

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
export const getPool = () => {
  if (!process.env.SUPABASE_DB_URL) throw new Error('SUPABASE_DB_URL belum diatur.');
  if (process.env.SUPABASE_REQUIRE_VERIFIED_TLS === 'true' && !process.env.SUPABASE_DB_CA) throw new Error('SUPABASE_DB_CA diperlukan untuk verifikasi TLS.');
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
const dummyPasswordHash = passwordHash(crypto.randomBytes(32).toString('hex'));
const passwordOk = (password, stored) => { try { const [salt, expected] = stored.split(':'); return crypto.timingSafeEqual(crypto.scryptSync(password, salt, 64), Buffer.from(expected, 'hex')); } catch { return false; } };
const validUrl = value => { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !!url.hostname; } catch { return false; } };
const validSlug = value => /^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])?$/.test(value) && !reserved.has(value);
const json = (value, status = 200, headers = {}) => Response.json(value, { status, headers: { 'Cache-Control':'no-store', ...headers } });
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new HttpError(status, message); };
const cookieValue = (request, key) => (request.headers.get('cookie') || '').split(';').map(x => x.trim()).find(x => x.startsWith(`${key}=`))?.slice(key.length + 1);
const sessionCookie = (token, secure, maxAge = 2592000) => `affilink_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
const userView = row => ({ id:row.id, username:row.username, slug:row.slug, displayName:row.display_name, bio:row.bio, avatarUrl:row.avatar_url, theme:row.theme || 'editorial' });
const productView = row => ({ id:row.id, title:row.title, description:row.description, category:row.category, subcategory:row.subcategory, tags:row.tags, affiliateUrl:row.affiliate_url, imageUrl:row.image_url, visible:row.visible !== false, featuredRank:row.featured_rank, createdAt:row.created_at, clicks:row.clicks, copies:row.copies, shares:row.shares, collectionIds:row.collection_ids });
const collectionView = row => ({ id:row.id, name:row.name, description:row.description, createdAt:row.created_at });
const readBody = async request => {
  if (Number(request.headers.get('content-length') || 0) > 4 * 1024 * 1024) fail(400, 'Data terlalu besar.');
  const raw = await request.text();
  if (Buffer.byteLength(raw) > 4 * 1024 * 1024) fail(400, 'Data terlalu besar.');
  try { return JSON.parse(raw || '{}'); } catch { fail(400, 'Format data tidak valid.'); }
};


export function createHandler({ pool, uploadImage = uploadToSupabase, env = process.env, fetcher = fetch, sendEmail }) {
  const rate = durableRate(pool);
  const rows = async (sql, args = []) => (await pool.query(sql, args)).rows;
  const one = async (sql, args = []) => (await rows(sql, args))[0] || null;
  const currentUser = async request => {
    const token = cookieValue(request, 'affilink_session');
    return token ? one(`SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>$2`, [digest(token), Date.now()]) : null;
  };
  const requireUser = async request => await currentUser(request) || fail(401, 'Silakan masuk terlebih dahulu.');
  const makeSession = async (userId, secure) => {
    const token = crypto.randomBytes(32).toString('hex');
    await pool.query('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)', [digest(token), userId, Date.now() + 30 * 86400000]);
    return sessionCookie(token, secure);
  };
  const productsFor = async (userId, overview = false) => (await rows(`SELECT p.*,
    (SELECT COUNT(*)::int FROM events e WHERE e.product_id=p.id AND e.type='click') clicks,
    (SELECT COUNT(*)::int FROM events e WHERE e.product_id=p.id AND e.type='copy') copies,
    (SELECT COUNT(*)::int FROM events e WHERE e.product_id=p.id AND e.type='share') shares,
    COALESCE((SELECT array_agg(cp.collection_id ORDER BY cp.collection_id) FROM collection_products cp WHERE cp.product_id=p.id), ARRAY[]::integer[]) collection_ids
    FROM products p WHERE p.user_id=$1 ${overview ? `AND p.visible AND (p.id IN (SELECT id FROM products WHERE user_id=$1 AND visible ORDER BY created_at DESC,id DESC LIMIT 10) OR p.id=(SELECT id FROM products WHERE user_id=$1 AND visible AND featured_rank IS NOT NULL ORDER BY featured_rank,id DESC LIMIT 1))` : ''} ORDER BY p.created_at DESC,p.id DESC`, [userId])).map(productView);
  const collectionsFor = async userId => (await rows('SELECT id,name,description,created_at FROM collections WHERE user_id=$1 ORDER BY created_at DESC,id DESC', [userId])).map(collectionView);
  const addEvent = (userId, productId, type, request) => pool.query('INSERT INTO events(user_id,product_id,type,visitor_hash,page_event) VALUES($1,$2,$3,$4,$5)', [userId, productId, type, request ? digest(cookieValue(request,'affalink_visitor') || crypto.randomUUID()) : null, productId===null]);
  const accounts = accountRoutes({pool,env,fetcher,sendEmail,currentUser,requireUser,readBody,json,fail,passwordHash,passwordOk,sessionCookie,rate});
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
      await upgrade(pool);
      const url = new URL(request.url);
      const route = url.pathname.replace(/^\/\.netlify\/functions\/api/, '/api');
      const method = request.method;
      if (!['GET','HEAD'].includes(method) && route !== '/api/billing/webhook') {
        const origin = request.headers.get('origin');
        if (origin && new URL(origin).host !== url.host) fail(403, 'Permintaan lintas situs ditolak.');
      }
      const accountResponse = await accounts(request,route,method);
      if (accountResponse) return accountResponse;
      if (route === '/api/categories' && method === 'GET') return json(categories);
      if (route === '/api/me' && method === 'GET') { const user = await currentUser(request); return json({ user:user ? userView(user) : null }); }
      if (route === '/api/slug-check' && method === 'GET') {
        const slug = clean(url.searchParams.get('slug'),32).toLowerCase();
        return json({ available:validSlug(slug) && !(await one('SELECT id FROM users WHERE slug=$1',[slug])) });
      }
      if (route === '/api/register' && method === 'POST') {
        if (!await rate(request,'register',8,3600000)) fail(429,'Terlalu banyak percobaan. Coba lagi nanti.');
        const body = await readBody(request), username = clean(body.username,32).toLowerCase(), slug = clean(body.slug,32).toLowerCase();
        const displayName = clean(body.displayName,60), password = String(body.password || '');
        if (!/^[a-z0-9_]{3,24}$/.test(username)) fail(400,'Username harus 3–24 karakter: huruf kecil, angka, atau garis bawah.');
        if (isAdmin({username},env)) fail(403,'Username ini tidak tersedia.');
        if (!validSlug(slug)) fail(400,'Nama link harus 3–30 karakter: huruf kecil, angka, atau tanda hubung.');
        if (!displayName) fail(400,'Nama tampilan wajib diisi.');
        if (password.length < 8 || password.length > 128) fail(400,'Password minimal 8 karakter.');
        if (await one('SELECT id FROM users WHERE username=$1 OR slug=$2',[username,slug])) fail(409,'Username atau link tidak tersedia.');
        const user = await one('INSERT INTO users(username,password_hash,slug,display_name) VALUES($1,$2,$3,$4) RETURNING id,username,slug,display_name,bio,avatar_url',[username,passwordHash(password),slug,displayName]);
        return json({ user:userView(user) },201,{ 'Set-Cookie':await makeSession(user.id,url.protocol==='https:') });
      }
      if (route === '/api/login' && method === 'POST') {
        if (!await rate(request,'login',12,15*60000)) fail(429,'Terlalu banyak percobaan. Coba lagi nanti.');
        const body = await readBody(request), username = clean(body.username,32).toLowerCase();
        const user = await one('SELECT * FROM users WHERE username=$1',[username]);
        if (!passwordOk(String(body.password || ''),user?.password_hash || dummyPasswordHash) || !user) fail(401,'Username atau password salah.');
        return json({ user:userView(user) },200,{ 'Set-Cookie':await makeSession(user.id,url.protocol==='https:') });
      }
      if (route === '/api/logout' && method === 'POST') {
        const token = cookieValue(request,'affilink_session');
        if (token) await pool.query('DELETE FROM sessions WHERE token_hash=$1',[digest(token)]);
        return json({ ok:true },200,{ 'Set-Cookie':sessionCookie('',url.protocol==='https:',0) });
      }
      const publicMatch = route.match(/^\/api\/public\/([a-z0-9-]+)$/);
      if (publicMatch && method === 'GET') {
        const user = await one('SELECT * FROM users WHERE slug=$1',[publicMatch[1]]);
        if (!user || !hasAccess(user,env)) fail(404,'Halaman tidak tersedia.');
        const visitor=cookieValue(request,'affalink_visitor') || crypto.randomBytes(24).toString('hex');
        const visitorHeaders=new Headers(request.headers); visitorHeaders.set('cookie',`affalink_visitor=${visitor}`);
        if (await rate(request,`visit:${user.id}`,1,30000)) await addEvent(user.id,null,'visit',new Request(request,{headers:visitorHeaders}));
        const collections=await rows(`SELECT c.*, (SELECT COUNT(*)::int FROM collection_products cp JOIN products p ON p.id=cp.product_id WHERE cp.collection_id=c.id AND p.visible) product_count FROM collections c WHERE c.user_id=$1 ORDER BY c.created_at DESC,c.id DESC`,[user.id]);
        return json({ user:userView(user), products:await productsFor(user.id,true), collections:collections.map(c=>({...collectionView(c),productCount:c.product_count})) },200,{'Set-Cookie':`affalink_visitor=${visitor}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${url.protocol==='https:' ? '; Secure' : ''}`});
      }
      const browse=route.match(/^\/api\/public\/([a-z0-9-]+)\/products$/);
      if(browse && method==='GET') {
        const owner=await one('SELECT * FROM users WHERE slug=$1',[browse[1]]);
        if(!owner || !hasAccess(owner,env)) fail(404,'Halaman tidak ditemukan.');
        const page=Math.max(1,Math.min(100000,Number.parseInt(url.searchParams.get('page'),10)||1));
        const q=clean(url.searchParams.get('q'),120).toLowerCase();
        const mode=url.searchParams.get('mode'), collection=Number(url.searchParams.get('collection')) || 0;
        const where=`p.user_id=$1 AND p.visible AND ($2='' OR STRPOS(LOWER(CONCAT_WS(' ',p.title,p.description,p.category,p.subcategory,p.tags::text)),$2)>0) ${mode==='featured' ? 'AND p.featured_rank IS NOT NULL' : ''} ${mode==='trending' ? "AND EXISTS(SELECT 1 FROM events e WHERE e.product_id=p.id AND e.type='click')" : ''} AND ($3=0 OR EXISTS(SELECT 1 FROM collection_products cp WHERE cp.product_id=p.id AND cp.collection_id=$3))`;
        const total=(await one(`SELECT COUNT(*)::int n FROM products p WHERE ${where}`,[owner.id,q,collection])).n;
        const pages=Math.max(1,Math.ceil(total/6)), current=Math.min(page,pages);
        const found=await rows(`SELECT p.*, (SELECT COUNT(*)::int FROM events e WHERE e.product_id=p.id AND e.type='click') clicks,0 copies,0 shares,COALESCE((SELECT array_agg(collection_id) FROM collection_products WHERE product_id=p.id),ARRAY[]::integer[]) collection_ids FROM products p WHERE ${where} ORDER BY ${mode==='featured' ? 'p.featured_rank ASC,' : mode==='trending' ? 'clicks DESC,' : ''} p.created_at DESC,p.id DESC LIMIT 6 OFFSET $4`,[owner.id,q,collection,(current-1)*6]);
        return json({products:found.map(productView),total,page:current,pages});
      }
      const pageShare=route.match(/^\/api\/public\/([a-z0-9-]+)\/share$/);
      if(pageShare && method==='POST') {
        if(!await rate(request,`page-share:${pageShare[1]}`,10,60000)) fail(429,'Terlalu banyak permintaan.');
        const owner=await one('SELECT * FROM users WHERE slug=$1',[pageShare[1]]);
        if(!owner || !hasAccess(owner,env)) fail(404,'Halaman tidak ditemukan.');
        await addEvent(owner.id,null,'share',request); return json({ok:true});
      }
      const track = route.match(/^\/api\/public\/([a-z0-9-]+)\/products\/(\d+)\/(click|copy|share)$/);
      if (track && method === 'POST') {
        if (!await rate(request,`event:${track[2]}`,30,60000)) fail(429,'Terlalu banyak permintaan.');
        const product = await one('SELECT p.id,p.user_id,u.username,u.active_until FROM products p JOIN users u ON u.id=p.user_id WHERE p.id=$1 AND u.slug=$2 AND p.visible=TRUE',[Number(track[2]),track[1]]);
        if (!product || !hasAccess(product,env)) fail(404,'Produk tidak ditemukan.');
        await addEvent(product.user_id,product.id,track[3],request); return json({ ok:true });
      }
      const user = await requireUser(request);
      if(!hasAccess(user,env) && method!=='GET') fail(402,'Masa aktif akun belum tersedia. Aktifkan paket terlebih dahulu.');
      if (route === '/api/dashboard' && method === 'GET') {
        const period=['7','30'].includes(url.searchParams.get('days')) ? Number(url.searchParams.get('days')) : 0;
        const since=period ? new Date(Date.now()-period*86400000).toISOString() : '1970-01-01T00:00:00Z';
        const totals = await one(`SELECT COUNT(DISTINCT visitor_hash) FILTER (WHERE type='visit')::int unique_visitors, COUNT(*) FILTER (WHERE type='share' AND page_event)::int page_shares, COUNT(*) FILTER (WHERE type='visit')::int visits, COUNT(*) FILTER (WHERE type='click')::int clicks, COUNT(*) FILTER (WHERE type='copy')::int copies, COUNT(*) FILTER (WHERE type='share')::int shares FROM events WHERE user_id=$1 AND created_at >= $2::timestamptz`,[user.id,since]);
        const daily = await rows(`SELECT TO_CHAR(created_at AT TIME ZONE 'Asia/Jakarta','YYYY-MM-DD') AS "day", COUNT(*)::int AS "count" FROM events WHERE user_id=$1 AND type='visit' AND created_at >= GREATEST($2::timestamptz,(DATE_TRUNC('day',NOW() AT TIME ZONE 'Asia/Jakarta') - INTERVAL '6 days') AT TIME ZONE 'Asia/Jakarta') GROUP BY 1 ORDER BY 1`,[user.id,since]);
        const topProducts=(await rows(`SELECT p.*,(SELECT COUNT(*)::int FROM events e WHERE e.product_id=p.id AND e.type='click' AND e.created_at >= $2::timestamptz) clicks,0 copies,0 shares,ARRAY[]::integer[] collection_ids FROM products p WHERE p.user_id=$1 ORDER BY clicks DESC,p.id DESC LIMIT 8`,[user.id,since])).map(productView);
        return json({ user:userView(user), products:await productsFor(user.id), collections:await collectionsFor(user.id), stats:{ ...totals,daily,topProducts } });
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
        if(!await rate(request,`upload:${user.id}`,30,3600000)) fail(429,'Batas unggahan per jam tercapai.');
        const body = await readBody(request), match = String(body.data || '').match(/^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/);
        if (!match) fail(400,'Pilih gambar PNG, JPG, WebP, atau GIF.');
        const buffer = Buffer.from(match[2],'base64');
        if (buffer.length > 2*1024*1024 || buffer.length < 12) fail(400,'Ukuran gambar maksimal 2 MB.');
        const signatures = { png:buffer.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')), jpeg:buffer.subarray(0,3).equals(Buffer.from('ffd8ff','hex')), webp:buffer.toString('ascii',0,4)==='RIFF' && buffer.toString('ascii',8,12)==='WEBP', gif:buffer.toString('ascii',0,3)==='GIF' };
        if (!signatures[match[1]]) fail(400,'Berkas gambar tidak valid.');
        const ext = {jpeg:'jpg',png:'png',webp:'webp',gif:'gif'}[match[1]], name = `${crypto.randomUUID()}.${ext}`;
        const client=await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[user.id]);
          const usage=(await client.query('SELECT COALESCE(SUM(bytes),0)::bigint bytes FROM uploaded_images WHERE user_id=$1',[user.id])).rows[0];
          if(Number(usage.bytes)+buffer.length>100*1024*1024) fail(400,'Batas unggahan 100 MB tercapai. Hubungi pengelola.');
          await client.query('INSERT INTO uploaded_images(name,user_id,bytes) VALUES($1,$2,$3)',[name,user.id,buffer.length]);
          await client.query('COMMIT');
        } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
        let uploadedUrl;
        try {uploadedUrl = await uploadImage(name,buffer,`image/${match[1]}`);}
        catch(error){await pool.query('DELETE FROM uploaded_images WHERE name=$1',[name]);throw error;}
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
      const visibility=route.match(/^\/api\/products\/(\d+)\/visibility$/);
      if(visibility && method==='PUT') {
        const body=await readBody(request); if(typeof body.visible!=='boolean') fail(400,'Status produk tidak valid.');
        const result=await pool.query('UPDATE products SET visible=$1 WHERE id=$2 AND user_id=$3 RETURNING id',[body.visible,Number(visibility[1]),user.id]);
        if(!result.rows.length) fail(404,'Produk tidak ditemukan.'); return json({ok:true});
      }
      const duplicate=route.match(/^\/api\/products\/(\d+)\/duplicate$/);
      if(duplicate && method==='POST') {
        const client=await pool.connect(); let id;
        try {
          await client.query('BEGIN');
          const result=await client.query("INSERT INTO products(user_id,title,description,category,subcategory,tags,affiliate_url,image_url,visible) SELECT user_id,LEFT(title,110)||' (salinan)',description,category,subcategory,tags,affiliate_url,image_url,FALSE FROM products WHERE id=$1 AND user_id=$2 RETURNING id",[Number(duplicate[1]),user.id]);
          if(!result.rows.length) fail(404,'Produk tidak ditemukan.'); id=result.rows[0].id;
          await client.query('INSERT INTO collection_products(collection_id,product_id) SELECT collection_id,$1 FROM collection_products WHERE product_id=$2',[id,Number(duplicate[1])]);
          await client.query('COMMIT');
        } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
        return json({id},201);
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
      console.error('Affalink API error',error?.code || error?.name || 'unknown');
      return json({ error:'Terjadi kesalahan server.' },500);
    }
  };
}

let liveHandler;
export default async function handler(request) {
  const pool = getPool();
  liveHandler ||= createHandler({ pool });
  return liveHandler(request);
}
