import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const sqlFile=path.join(process.cwd(),'supabase/upgrade.sql');
const sql = fs.readFileSync(fs.existsSync(sqlFile) ? sqlFile : new URL('../../../supabase/upgrade.sql', import.meta.url), 'utf8');
const migrations = new WeakMap();
export async function upgrade(pool) {
  if (!migrations.has(pool)) migrations.set(pool, (async () => {
    for (const statement of sql.replace(/--[^\n]*/g,'').split(';').map(s=>s.trim()).filter(Boolean)) await pool.query(statement);
  })().catch(error => { migrations.delete(pool); throw error; }));
  await migrations.get(pool);
}
export const paymentSettings = (env = process.env) => {
  const days = Number(env.PLAN_DURATION_DAYS || 0);
  return { enabled:env.BILLING_ENABLED === 'true', price:50000, days:Number.isInteger(days) && days > 0 && days <= 3650 ? days : 0, production:env.MIDTRANS_PRODUCTION === 'true' };
};
export const isAdmin = (user, env = process.env) => !!user && (env.ADMIN_USERNAMES || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean).includes(user.username);
export const hasAccess = (user, env = process.env) => !paymentSettings(env).enabled || isAdmin(user,env) || new Date(user.active_until).getTime() > Date.now();
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
export function durableRate(pool) {
  return async (request, key, count, interval) => {
    const ip = request.headers.get('x-nf-client-connection-ip') || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
    const now = Date.now(), expires = (Math.floor(now / interval) + 1) * interval;
    const id = hash(`${ip}:${key}:${expires}`);
    const result = await pool.query(`INSERT INTO rate_limits(key,hits,expires_at) VALUES($1,1,$2)
      ON CONFLICT(key) DO UPDATE SET hits=rate_limits.hits+1 WHERE rate_limits.hits<$3 RETURNING hits`,[id,expires,count]);
    // Remove only a small batch, keeping request latency bounded.
    if (crypto.randomInt(100) === 0) await pool.query('DELETE FROM rate_limits WHERE key IN (SELECT key FROM rate_limits WHERE expires_at<$1 LIMIT 200)',[now]);
    return result.rows.length > 0;
  };
}
export function accountRoutes({ pool, env = process.env, fetcher = fetch, currentUser, requireUser, readBody, json, fail, passwordHash, passwordOk, sessionCookie, rate, sendEmail }) {
  const one = async (sql,args=[]) => (await pool.query(sql,args)).rows[0];
  const mailReady = () => !!sendEmail || !!(env.RESEND_API_KEY && env.EMAIL_FROM);
  const send = async (email,subject,text) => {
    if (sendEmail) return sendEmail({ to:email,subject,text });
    if (!mailReady()) fail(503,'Email pemulihan belum disiapkan. Hubungi pengelola.');
    const response = await fetcher('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${env.RESEND_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({from:env.EMAIL_FROM,to:[email],subject,text}),signal:AbortSignal.timeout(10000)});
    if (!response.ok) fail(503,'Email belum berhasil dikirim. Coba lagi nanti.');
  };
  const site = request => {
    const base = env.SITE_URL || new URL(request.url).origin;
    const url = new URL(base);
    if (!['http:','https:'].includes(url.protocol)) fail(503,'Alamat website belum disiapkan.');
    return url.origin;
  };
  const issueToken = async (user,email,purpose,request) => {
    const token = crypto.randomBytes(32).toString('hex'), tokenHash = hash(token);
    await pool.query('DELETE FROM account_tokens WHERE user_id=$1 AND purpose=$2',[user.id,purpose]);
    await pool.query('INSERT INTO account_tokens(token_hash,user_id,purpose,email,expires_at) VALUES($1,$2,$3,$4,$5)',[tokenHash,user.id,purpose,email,Date.now()+30*60000]);
    try { await send(email,purpose === 'verify' ? 'Verifikasi email Affalink' : 'Atur ulang password Affalink',`Buka tautan berikut dalam 30 menit:\n${site(request)}/auth?${purpose === 'verify' ? 'verify' : 'reset'}=${token}\n\nAbaikan jika kamu tidak meminta perubahan ini.`); }
    catch(error) { await pool.query('DELETE FROM account_tokens WHERE token_hash=$1',[tokenHash]); throw error; }
  };
  const midtrans = async (path,body) => {
    const cfg=paymentSettings(env);
    if (!env.MIDTRANS_SERVER_KEY || !cfg.days) fail(503,'Pembayaran belum disiapkan oleh pengelola.');
    const base = body ? (cfg.production ? 'https://app.midtrans.com' : 'https://app.sandbox.midtrans.com') : (cfg.production ? 'https://api.midtrans.com' : 'https://api.sandbox.midtrans.com');
    const response=await fetcher(`${base}${path}`,{method:body ? 'POST' : 'GET',headers:{Authorization:`Basic ${Buffer.from(`${env.MIDTRANS_SERVER_KEY}:`).toString('base64')}`,'Content-Type':'application/json',Accept:'application/json'},...(body ? {body:JSON.stringify(body)} : {}),signal:AbortSignal.timeout(10000)});
    if (!response.ok) { if(response.status===404 && !body) return null; fail(503,'Midtrans belum dapat dihubungi. Coba lagi nanti.'); }
    return response.json();
  };
  const applyPayment = async payload => {
    const status=String(payload.transaction_status || '');
    const success=['settlement','capture'].includes(status) && String(payload.status_code)==='200' && (!payload.fraud_status || payload.fraud_status === 'accept');
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      const order=(await client.query('SELECT * FROM payment_orders WHERE id=$1 FOR UPDATE',[payload.order_id])).rows[0];
      if (!order) fail(404,'Pesanan tidak ditemukan.');
      if (Number(payload.gross_amount)!==order.amount || (payload.currency && payload.currency!=='IDR')) fail(400,'Nominal pembayaran tidak sesuai.');
      if (!order.paid_at && success) {
        // Lock the account so two distinct paid orders cannot overwrite one another.
        await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[order.user_id]);
        await client.query("UPDATE users SET active_until=GREATEST(COALESCE(active_until,NOW()),NOW()) + ($1 * INTERVAL '1 day') WHERE id=$2",[order.duration_days,order.user_id]);
        await client.query("UPDATE payment_orders SET status='paid',paid_at=NOW() WHERE id=$1",[order.id]);
      } else if (!order.paid_at && ['pending','deny','cancel','expire','failure'].includes(status)) await client.query('UPDATE payment_orders SET status=$1 WHERE id=$2',[status,order.id]);
      await client.query('COMMIT');
    } catch(error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    return json({ok:true});
  };
  return async (request,route,method) => {
    if(route === '/api/config' && method === 'GET') {
      const cfg=paymentSettings(env);
      return json({billing:cfg.enabled,price:cfg.price,days:cfg.days,paymentReady:!!env.MIDTRANS_SERVER_KEY && !!cfg.days,emailReady:mailReady(),supportEmail:env.SUPPORT_EMAIL || ''});
    }
    if(route === '/api/billing/webhook' && method === 'POST') {
      if(!env.MIDTRANS_SERVER_KEY) fail(503,'Pembayaran belum disiapkan.');
      const body=await readBody(request);
      const expected=crypto.createHash('sha512').update(`${body.order_id}${body.status_code}${body.gross_amount}${env.MIDTRANS_SERVER_KEY}`).digest('hex');
      if(!/^[a-f0-9]{128}$/i.test(body.signature_key || '') || !crypto.timingSafeEqual(Buffer.from(expected,'hex'),Buffer.from(body.signature_key,'hex'))) fail(403,'Tanda tangan pembayaran tidak valid.');
      // Fetch the authoritative latest status rather than trusting a stale notification.
      const status=await midtrans(`/v2/${encodeURIComponent(body.order_id)}/status`);
      if(!status || status.order_id!==body.order_id) fail(400,'Status pembayaran belum tersedia.');
      return applyPayment(status);
    }
    if(route === '/api/account/forgot' && method === 'POST') {
      if(!mailReady()) fail(503,'Email pemulihan belum disiapkan. Hubungi pengelola.');
      if(!await rate(request,'forgot',4,3600000)) fail(429,'Coba lagi nanti.');
      const body=await readBody(request), email=String(body.email || '').trim().toLowerCase();
      const user=await one('SELECT * FROM users WHERE lower(email)=$1 AND email_verified_at IS NOT NULL',[email]);
      if(user) {try {await issueToken(user,email,'reset',request);}catch(error){console.error('Recovery email delivery failed',error.name);}}
      return json({message:'Jika email terdaftar dan sudah diverifikasi, tautan pemulihan akan dikirim.'});
    }
    if(['/api/account/reset','/api/account/verify'].includes(route) && method === 'POST') {
      if(!await rate(request,'account-token',15,3600000)) fail(429,'Coba lagi nanti.');
      const body=await readBody(request), purpose=route.endsWith('reset') ? 'reset' : 'verify';
      const password=String(body.password || '');
      if(purpose==='reset' && (password.length<8 || password.length>128)) fail(400,'Password harus 8–128 karakter.');
      const client=await pool.connect();
      try {
        await client.query('BEGIN');
        const token=(await client.query('DELETE FROM account_tokens WHERE token_hash=$1 AND purpose=$2 AND expires_at>$3 RETURNING *',[hash(String(body.token || '')),purpose,Date.now()])).rows[0];
        if(!token) fail(400,'Tautan tidak valid atau sudah kedaluwarsa.');
        if(purpose==='verify') await client.query('UPDATE users SET email=$1,email_verified_at=NOW() WHERE id=$2',[token.email,token.user_id]);
        else {
          const owner=(await client.query('SELECT * FROM users WHERE id=$1 FOR UPDATE',[token.user_id])).rows[0];
          if(owner.email!==token.email || !owner.email_verified_at) fail(400,'Email pemulihan sudah berubah.');
          await client.query('UPDATE users SET password_hash=$1 WHERE id=$2',[passwordHash(password),token.user_id]);
          await client.query('DELETE FROM sessions WHERE user_id=$1',[token.user_id]);
        }
        await client.query('COMMIT');
      } catch(error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
      return json({ok:true},200,purpose==='reset' ? {'Set-Cookie':sessionCookie('',new URL(request.url).protocol==='https:',0)} : {});
    }
    if(!/^\/api\/(account|billing|admin)(\/|$)/.test(route)) return null;
    const user=await requireUser(request);
    const full=await one('SELECT * FROM users WHERE id=$1',[user.id]);
    if(route === '/api/account' && method==='GET') return json({email:full.email || '',emailVerified:!!full.email_verified_at,emailReady:mailReady(),activeUntil:full.active_until,access:hasAccess(full,env),admin:isAdmin(full,env)});
    if(route === '/api/account/email' && method==='POST') {
      if(!mailReady()) fail(503,'Email pemulihan belum disiapkan.');
      if(!await rate(request,`verify:${user.id}`,3,3600000)) fail(429,'Coba lagi nanti.');
      const body=await readBody(request),email=String(body.email || '').trim().toLowerCase();
      if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length>254) fail(400,'Alamat email tidak valid.');
      if(!passwordOk(String(body.password || ''),full.password_hash)) fail(401,'Password saat ini salah.');
      if(await one('SELECT id FROM users WHERE lower(email)=$1 AND id<>$2',[email,user.id])) fail(409,'Email tidak dapat digunakan.');
      await issueToken(full,email,'verify',request);
      return json({message:'Tautan verifikasi sudah dikirim. Buka email kamu.'});
    }
    if(route === '/api/account/password' && method==='POST') {
      if(!await rate(request,`password:${user.id}`,5,3600000)) fail(429,'Coba lagi nanti.');
      const body=await readBody(request),password=String(body.password || '');
      if(!passwordOk(String(body.currentPassword || ''),full.password_hash)) fail(401,'Password saat ini salah.');
      if(password.length<8 || password.length>128) fail(400,'Password harus 8–128 karakter.');
      const client=await pool.connect();
      try { await client.query('BEGIN'); await client.query('UPDATE users SET password_hash=$1 WHERE id=$2',[passwordHash(password),user.id]); await client.query('DELETE FROM sessions WHERE user_id=$1',[user.id]); await client.query('DELETE FROM account_tokens WHERE user_id=$1',[user.id]); await client.query('COMMIT'); }
      catch(error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
      return json({ok:true},200,{'Set-Cookie':sessionCookie('',new URL(request.url).protocol==='https:',0)});
    }
    if(route === '/api/billing' && method==='GET') return json({orders:(await pool.query('SELECT id,amount,duration_days,status,checkout_url,paid_at,created_at FROM payment_orders WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20',[user.id])).rows});
    if(route === '/api/billing/checkout' && method==='POST') {
      const cfg=paymentSettings(env);
      if(!cfg.enabled) fail(400,'Paket berbayar belum dibuka.');
      if(!await rate(request,`checkout:${user.id}`,5,3600000)) fail(429,'Terlalu banyak permintaan pembayaran.');
      if(!env.MIDTRANS_SERVER_KEY || !cfg.days) fail(503,'Pembayaran belum disiapkan oleh pengelola.');
      const existing=await one("SELECT * FROM payment_orders WHERE user_id=$1 AND status IN ('created','pending') AND checkout_url IS NOT NULL AND created_at>NOW()-INTERVAL '1 hour' ORDER BY created_at DESC LIMIT 1",[user.id]);
      if(existing) return json({url:existing.checkout_url});
      const id=`affalink-${crypto.randomUUID()}`;
      await pool.query('INSERT INTO payment_orders(id,user_id,amount,duration_days) VALUES($1,$2,$3,$4)',[id,user.id,cfg.price,cfg.days]);
      const transaction=await midtrans('/snap/v1/transactions',{transaction_details:{order_id:id,gross_amount:cfg.price},credit_card:{secure:true},item_details:[{id:'affalink-access',price:cfg.price,quantity:1,name:`Affalink ${cfg.days} hari`}],customer_details:{first_name:full.display_name,...(full.email_verified_at ? {email:full.email} : {})},callbacks:{finish:`${site(request)}/app?payment=return`}});
      const redirect=new URL(transaction.redirect_url);
      if(redirect.protocol!=='https:' || !['app.midtrans.com','app.sandbox.midtrans.com'].includes(redirect.hostname)) fail(503,'Alamat pembayaran tidak valid.');
      await pool.query("UPDATE payment_orders SET status='pending',checkout_url=$1 WHERE id=$2",[redirect.href,id]);
      return json({url:redirect.href});
    }
    if(route === '/api/billing/refresh' && method==='POST') {
      if(!await rate(request,`payment-refresh:${user.id}`,10,60000)) fail(429,'Tunggu sebentar sebelum memeriksa lagi.');
      const order=await one("SELECT * FROM payment_orders WHERE user_id=$1 AND paid_at IS NULL AND status IN ('created','pending') ORDER BY created_at DESC LIMIT 1",[user.id]);
      if(order) { const status=await midtrans(`/v2/${encodeURIComponent(order.id)}/status`); if(status && status.order_id===order.id) await applyPayment(status); }
      return json({ok:true});
    }
    if(route.startsWith('/api/admin')) {
      if(!isAdmin(full,env)) fail(403,'Akses admin diperlukan.');
      if(route==='/api/admin' && method==='GET') return json({users:(await pool.query('SELECT id,username,display_name,slug,active_until,email_verified_at,(SELECT COUNT(*)::int FROM products p WHERE p.user_id=u.id) products,(SELECT COALESCE(SUM(bytes),0)::bigint FROM uploaded_images i WHERE i.user_id=u.id) storage_bytes FROM users u ORDER BY id DESC LIMIT 200')).rows,orders:(await pool.query('SELECT o.id,u.username,o.amount,o.status,o.created_at,o.paid_at FROM payment_orders o JOIN users u ON u.id=o.user_id ORDER BY o.created_at DESC LIMIT 100')).rows});
    }
    fail(404,'Alamat API tidak ditemukan.');
  };
}
