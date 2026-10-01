import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { createHandler, getPool } from './netlify/functions/api.mjs';
import { upgrade,hasAccess } from './netlify/functions/lib/accounts.mjs';
import {withMetadata} from './netlify/functions/lib/metadata.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const dataDir=process.env.AFFILINK_DATA_DIR || path.join(root,'data');
const uploadDir=process.env.AFFILINK_UPLOAD_DIR || path.join(root,'uploads');
fs.mkdirSync(dataDir,{recursive:true});fs.mkdirSync(uploadDir,{recursive:true});
let pool, db;
if(process.env.SUPABASE_DB_URL) pool=getPool();
else {
  db=new PGlite(path.join(dataDir,'postgres'));
  if(!(await db.query("SELECT to_regclass('public.users') present")).rows[0].present) {
    await db.exec(fs.readFileSync(path.join(root,'supabase/schema.sql'),'utf8'));
    // Import the previous local SQLite database without changing the original file.
    const oldPath=path.join(dataDir,'affilink.sqlite');
    if(fs.existsSync(oldPath)) {
      const {DatabaseSync}=await import('node:sqlite');const old=new DatabaseSync(oldPath,{readOnly:true});
      try {
        await db.exec('BEGIN');
        for(const table of ['users','sessions','collections','products','collection_products','events']) {
          const columns=(await db.query('SELECT column_name FROM information_schema.columns WHERE table_name=$1',[table])).rows.map(r=>r.column_name);
          for(const row of old.prepare(`SELECT * FROM ${table}`).all()) {
            const keys=Object.keys(row).filter(k=>columns.includes(k));
            const values=keys.map(k=>row[k]);
            await db.query(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map((_,i)=>`$${i+1}`).join(',')})`,values);
          }
          if(columns.includes('id')) await db.query(`SELECT setval(pg_get_serial_sequence('${table}','id'),GREATEST(COALESCE((SELECT MAX(id) FROM ${table}),0),1),EXISTS(SELECT 1 FROM ${table}))`);
        }
        await db.exec('COMMIT');console.log('Data lokal lama berhasil disalin ke PostgreSQL lokal.');
      } catch(error){await db.exec('ROLLBACK');throw error;} finally {old.close();}
    }
  }
  const query=async (...args)=>{const result=await db.query(...args);return {rows:result.rows,rowCount:result.affectedRows ?? result.rows.length};};
  // Serialize requests: PGlite uses one connection, including transactions.
  pool={query,connect:async()=>({query,release(){}})};
}
await upgrade(pool);
const handler=createHandler({pool,...(!process.env.SUPABASE_DB_URL ? {uploadImage:async(name,bytes)=>{await fs.promises.writeFile(path.join(uploadDir,name),bytes);return `/uploads/${name}`;}} : {})});
const template=fs.readFileSync(path.join(root,'public/index.html'),'utf8');
const mime={'.css':'text/css','.js':'text/javascript','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.gif':'image/gif'};
let queue=Promise.resolve();
const serve=async(req,res)=>{
  try {
    const url=new URL(req.url,`http://localhost:${process.env.PORT || 3000}`);
    if(url.pathname.startsWith('/api/')) {
      const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>4*1024*1024){res.writeHead(413);res.end();return;}chunks.push(chunk);}
      const response=await handler(new Request(url,{method:req.method,headers:req.headers,...(!['GET','HEAD'].includes(req.method) ? {body:Buffer.concat(chunks)} : {})}));
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));return;
    }
    const directory=url.pathname.startsWith('/uploads/') ? uploadDir : path.join(root,'public');
    const relative=directory===uploadDir ? url.pathname.slice('/uploads/'.length) : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const filename=path.resolve(directory,relative);
    if(filename.startsWith(path.resolve(directory)+path.sep) && fs.existsSync(filename) && fs.statSync(filename).isFile()) {res.writeHead(200,{'Content-Type':mime[path.extname(filename)] || 'application/octet-stream'});fs.createReadStream(filename).pipe(res);return;}
    let html=template;
    const slug=url.pathname.slice(1).replace(/\/$/,'');
    if(/^[a-z0-9-]{3,30}$/.test(slug) && !['app','auth','demo'].includes(slug)) {const user=(await pool.query('SELECT * FROM users WHERE slug=$1',[slug])).rows[0];if(user && hasAccess(user))html=withMetadata(template,user,url.origin);}
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(html);
  }catch(error){console.error('Local server error',error.code || error.name);res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'Terjadi kesalahan server.'}));}
};
const server=http.createServer((req,res)=>{if(db)queue=queue.then(()=>serve(req,res));else serve(req,res);});
server.listen(Number(process.env.PORT || 3000),()=>console.log(`Affalink: http://localhost:${process.env.PORT || 3000} (${db ? 'database lokal' : 'Supabase'})`));
process.on('SIGINT',()=>server.close(async()=>{if(db)await db.close();else await pool.end();process.exit(0);}));
