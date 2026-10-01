import fs from 'node:fs';
import {getPool} from './api.mjs';
import {upgrade,hasAccess} from './lib/accounts.mjs';
import {withMetadata} from './lib/metadata.mjs';
const html=fs.readFileSync(new URL('../../public/index.html',import.meta.url),'utf8');
export default async request=>{
  const url=new URL(request.url),slug=url.searchParams.get('slug') || '';
  let result=html;
  if(/^[a-z0-9-]{3,30}$/.test(slug) && !['auth','app','demo','admin'].includes(slug)) {
    try {const pool=getPool();await upgrade(pool);const user=(await pool.query('SELECT * FROM users WHERE slug=$1',[slug])).rows[0];if(user && hasAccess(user)) result=withMetadata(html,user,process.env.SITE_URL ? new URL(process.env.SITE_URL).origin : url.origin);}
    catch(error){console.error('Metadata tidak termuat',error.code || error.name);}
  }
  return new Response(result,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'strict-origin-when-cross-origin','X-Content-Type-Options':'nosniff'}});
};
