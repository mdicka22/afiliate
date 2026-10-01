import {test} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {createHandler} from '../netlify/functions/api.mjs';
import {withMetadata} from '../netlify/functions/lib/metadata.mjs';

async function setup(options={}) {
  const db=new PGlite();await db.exec(fs.readFileSync(new URL('../supabase/schema.sql',import.meta.url),'utf8'));
  const query=async(...args)=>{const r=await db.query(...args);return {rows:r.rows,rowCount:r.affectedRows ?? r.rows.length};};
  const pool={query,connect:async()=>({query,release(){}})};
  const env=options.env || {};
  let handler=createHandler({pool,env,...options});
  const call=async(route,method='GET',body,cookie='',ip='127.0.0.1')=>{
    const response=await handler(new Request(`https://affalink.example${route}`,{method,headers:{'Content-Type':'application/json','x-nf-client-connection-ip':ip,...(cookie?{Cookie:cookie}: {})},...(body===undefined?{}:{body:JSON.stringify(body)})}));
    return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
  };
  const register=(name='tester')=>call('/api/register','POST',{username:name,slug:name,displayName:name,password:'password123'});
  return {db,pool,call,register,recreate:()=>{handler=createHandler({pool,env,...options});}};
}
test('Midtrans activates once, validates signatures/amount, and enforces expiry',async()=>{
  const env={BILLING_ENABLED:'true',PLAN_DURATION_DAYS:'30',MIDTRANS_SERVER_KEY:'sandbox-test-key'};
  let statusPayload;
  const f=await setup({env,fetcher:async(url,options)=>{
    assert.ok(options.headers.Authorization.startsWith('Basic '));
    if(url.endsWith('/transactions')) {const body=JSON.parse(options.body);assert.equal(body.transaction_details.gross_amount,50000);statusPayload={order_id:body.transaction_details.order_id,gross_amount:'50000.00',status_code:'200',transaction_status:'settlement',fraud_status:'accept',currency:'IDR'};return Response.json({redirect_url:'https://app.sandbox.midtrans.com/snap/v2/test'});}
    return Response.json(statusPayload);
  }});
  try {
    const user=await f.register();assert.equal(user.status,201);
    assert.equal((await f.call('/api/account','GET',undefined,user.cookie)).data.access,false);
    assert.equal((await f.call('/api/products','POST',{},user.cookie)).status,402);
    assert.equal((await f.call('/api/public/tester')).status,404);
    assert.equal((await f.call('/api/billing/checkout','POST',{},user.cookie)).status,200);
    const notification=()=>({...statusPayload,signature_key:crypto.createHash('sha512').update(`${statusPayload.order_id}${statusPayload.status_code}${statusPayload.gross_amount}${env.MIDTRANS_SERVER_KEY}`).digest('hex')});
    assert.equal((await f.call('/api/billing/webhook','POST',{...notification(),signature_key:'0'.repeat(128)})).status,403);
    statusPayload.gross_amount='1.00';assert.equal((await f.call('/api/billing/webhook','POST',notification())).status,400);
    assert.equal((await f.call('/api/account','GET',undefined,user.cookie)).data.access,false);
    statusPayload.gross_amount='50000.00';statusPayload.fraud_status='challenge';
    assert.equal((await f.call('/api/billing/webhook','POST',notification())).status,200);
    assert.equal((await f.call('/api/account','GET',undefined,user.cookie)).data.access,false);
    statusPayload.fraud_status='accept';assert.equal((await f.call('/api/billing/webhook','POST',notification())).status,200);
    const first=(await f.call('/api/account','GET',undefined,user.cookie)).data;assert.ok(first.access);
    assert.ok(new Date(first.activeUntil)-Date.now()>29*86400000);
    f.recreate();assert.equal((await f.call('/api/billing/webhook','POST',notification())).status,200);
    assert.equal((await f.call('/api/account','GET',undefined,user.cookie)).data.activeUntil,first.activeUntil);
    const other=await f.register('another');assert.equal((await f.call('/api/billing','GET',undefined,other.cookie)).data.orders.length,0);
    assert.equal((await f.call('/api/admin','GET',undefined,user.cookie)).status,403);
    const owner=await f.register('owner');env.ADMIN_USERNAMES='owner';assert.equal((await f.call('/api/admin','GET',undefined,owner.cookie)).status,200);
    env.ADMIN_USERNAMES='owner,reservedadmin';assert.equal((await f.register('reservedadmin')).status,403);
    await f.pool.query("UPDATE users SET active_until=NOW()-INTERVAL '1 day' WHERE username='tester'");
    assert.equal((await f.call('/api/account','GET',undefined,user.cookie)).data.access,false);
  }finally{await f.db.close();}
});
test('verified email recovery is single use and revokes sessions',async()=>{
  const mails=[];const f=await setup({sendEmail:async mail=>mails.push(mail)});
  try {
    const user=await f.register();
    assert.equal((await f.call('/api/account/email','POST',{email:'test@example.com',password:'wrong'},user.cookie)).status,401);
    assert.equal((await f.call('/api/account/email','POST',{email:'test@example.com',password:'password123'},user.cookie)).status,200);
    const verify=mails[0].text.match(/verify=([a-f0-9]{64})/)[1];
    assert.equal((await f.call('/api/account/verify','POST',{token:verify})).status,200);
    assert.equal((await f.call('/api/account/verify','POST',{token:verify})).status,400);
    const known=await f.call('/api/account/forgot','POST',{email:'test@example.com'});
    const unknown=await f.call('/api/account/forgot','POST',{email:'unknown@example.com'});
    assert.deepEqual(known.data,unknown.data);assert.equal(mails.length,2);
    const reset=mails[1].text.match(/reset=([a-f0-9]{64})/)[1];
    assert.equal((await f.call('/api/account/reset','POST',{token:reset,password:'replacement123'})).status,200);
    assert.equal((await f.call('/api/account/reset','POST',{token:reset,password:'anotherpass'})).status,400);
    assert.equal((await f.call('/api/me','GET',undefined,user.cookie)).data.user,null);
    assert.equal((await f.call('/api/login','POST',{username:'tester',password:'password123'})).status,401);
    const login=await f.call('/api/login','POST',{username:'tester',password:'replacement123'});assert.equal(login.status,200);
    assert.equal((await f.call('/api/account/password','POST',{currentPassword:'replacement123',password:'finalpassword'},login.cookie)).status,200);
    assert.equal((await f.call('/api/me','GET',undefined,login.cookie)).data.user,null);
  }finally{await f.db.close();}
});
test('rate limits survive handler recreation',async()=>{
  const f=await setup();try{
    for(let i=0;i<12;i++){f.recreate();assert.equal((await f.call('/api/login','POST',{username:'none',password:'wrong'})).status,401);}
    f.recreate();assert.equal((await f.call('/api/login','POST',{username:'none',password:'wrong'})).status,429);
    assert.equal((await f.call('/api/login','POST',{username:'none',password:'wrong'},'','127.0.0.2')).status,401);
  }finally{await f.db.close();}
});
test('hidden products remain private; pagination and tags search run in database',async()=>{
  const f=await setup();try{
    const user=await f.register(),other=await f.register('another');let first;
    for(let i=0;i<13;i++){
      const product=await f.call('/api/products','POST',{title:`Produk ${i}`,category:'Beauty & Personal Care',subcategory:'Skincare',affiliateUrl:'https://example.com',tags:i===0?['unik']:[],description:'Pilihan'},user.cookie);assert.equal(product.status,201);first ??=product.data.id;
    }
    assert.equal((await f.call('/api/public/tester')).data.products.length,10);
    const search=await f.call('/api/public/tester/products?q=unik');assert.equal(search.data.total,1);assert.equal(search.data.products[0].id,first);
    const page=await f.call('/api/public/tester/products?page=2');assert.equal(page.data.products.length,6);assert.equal(page.data.pages,3);
    assert.equal((await f.call(`/api/products/${first}/visibility`,'PUT',{visible:false},other.cookie)).status,404);
    assert.equal((await f.call(`/api/products/${first}/visibility`,'PUT',{visible:false},user.cookie)).status,200);
    assert.equal((await f.call('/api/public/tester/products?q=unik')).data.total,0);
    assert.equal((await f.call(`/api/public/tester/products/${first}/click`,'POST',{})).status,404);
    const duplicate=await f.call(`/api/products/${first}/duplicate`,'POST',{},user.cookie);assert.equal(duplicate.status,201);
    const dashboard=await f.call('/api/dashboard','GET',undefined,user.cookie);assert.equal(dashboard.data.products.find(p=>p.id===duplicate.data.id).visible,false);
  }finally{await f.db.close();}
});
test('visitor identity, page sharing, period statistics and WIB day boundaries',async()=>{
  const f=await setup();try{
    const user=await f.register();const visit=await f.call('/api/public/tester');
    assert.ok(visit.cookie?.startsWith('affalink_visitor='));
    await f.pool.query('DELETE FROM rate_limits');
    await f.call('/api/public/tester','GET',undefined,visit.cookie);
    await f.call('/api/public/tester/share','POST',{},visit.cookie);
    const stats=(await f.call('/api/dashboard?days=7','GET',undefined,user.cookie)).data.stats;
    assert.equal(stats.visits,2);assert.equal(stats.unique_visitors,1);assert.equal(stats.page_shares,1);
    const product=await f.call('/api/products','POST',{title:'Uji share',category:'Beauty & Personal Care',subcategory:'Skincare',affiliateUrl:'https://example.com'},user.cookie);
    await f.call(`/api/public/tester/products/${product.data.id}/share`,'POST',{},visit.cookie);
    await f.call(`/api/products/${product.data.id}`,'DELETE',undefined,user.cookie);
    assert.equal((await f.call('/api/dashboard','GET',undefined,user.cookie)).data.stats.page_shares,1);
    const day=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Jakarta'}).format(new Date());assert.equal(stats.daily[0].day,day);
    await f.pool.query("UPDATE events SET created_at=NOW()-INTERVAL '10 days'");
    assert.equal((await f.call('/api/dashboard?days=7','GET',undefined,user.cookie)).data.stats.visits,0);
    assert.equal((await f.call('/api/dashboard?days=30','GET',undefined,user.cookie)).data.stats.visits,2);
  }finally{await f.db.close();}
});
test('share metadata escapes profile fields without executable markup',()=>{
  const html=withMetadata('<head><title>Old</title><meta name="description" content="Old"></head>',{display_name:'<script>alert(1)</script>',bio:'" onload="bad',slug:'tester',avatar_url:'javascript:alert(1)'},'https://affalink.example');
  assert.ok(!html.includes('<script>'));assert.ok(html.includes('&lt;script&gt;'));assert.ok(html.includes('og:url'));assert.ok(!html.includes('javascript:'));assert.ok(html.includes('/assets/affalink-3d.png'));
});

test('admin filters, pagination, access grants, suspension and audit preserve boundaries',async()=>{
  const env={};const f=await setup({env});
  try {
    const owner=await f.register('owner'),target=await f.register('member');env.ADMIN_USERNAMES='owner';
    const endpoint=`/api/admin/users/${target.data.user.id}`;
    assert.equal((await f.call(`${endpoint}/access`,'PUT',{days:30,reason:'Kompensasi layanan'},target.cookie)).status,403);
    assert.equal((await f.call(`${endpoint}/access`,'PUT',{days:0,reason:'Kompensasi layanan'},owner.cookie)).status,400);
    assert.equal((await f.call(`${endpoint}/access`,'PUT',{days:30,reason:'a'},owner.cookie)).status,400);
    assert.equal((await f.call(`${endpoint}/access`,'PUT',{days:30,reason:'Kompensasi layanan'},owner.cookie)).status,200);
    assert.ok((await f.call('/api/account','GET',undefined,target.cookie)).data.activeUntil);
    const product=await f.call('/api/products','POST',{title:'Pilihan member',category:'Beauty & Personal Care',subcategory:'Skincare',affiliateUrl:'https://example.com'},target.cookie);
    assert.equal(product.status,201);
    assert.equal((await f.call(`${endpoint}/suspension`,'PUT',{suspended:true,reason:'Peninjauan penyalahgunaan'},owner.cookie)).status,200);
    assert.equal((await f.call('/api/me','GET',undefined,target.cookie)).data.user,null);
    assert.equal((await f.call('/api/public/member')).status,404);
    assert.equal((await f.call(`/api/public/member/products/${product.data.id}/click`,'POST',{})).status,404);
    assert.equal((await f.call('/api/login','POST',{username:'member',password:'password123'})).status,403);
    const suspended=await f.call('/api/admin?status=suspended','GET',undefined,owner.cookie);
    assert.equal(suspended.data.users.length,1);assert.equal(suspended.data.users[0].username,'member');
    assert.equal((await f.call(`/api/admin/users/${owner.data.user.id}/suspension`,'PUT',{suspended:true,reason:'Uji perlindungan admin'},owner.cookie)).status,400);
    assert.equal((await f.call(`${endpoint}/suspension`,'PUT',{suspended:false,reason:'Peninjauan selesai'},owner.cookie)).status,200);
    const relogin=await f.call('/api/login','POST',{username:'member',password:'password123'});assert.equal(relogin.status,200);
    assert.equal((await f.call('/api/public/member')).data.products.length,1);
    const board=await f.call('/api/admin?q=member&status=active','GET',undefined,owner.cookie);
    assert.equal(board.data.pagination.total,1);assert.equal(Number(board.data.summary.revenue),0);
    assert.equal(board.data.audit.length,3);assert.equal(board.data.audit[0].reason,'Peninjauan selesai');
    assert.equal(board.data.health.email,false);assert.ok(!JSON.stringify(board.data).includes('password_hash'));
    await f.pool.query("INSERT INTO users(username,password_hash,slug,display_name) SELECT 'person'||g,u.password_hash,'person'||g,'Person '||g FROM generate_series(1,23) g CROSS JOIN users u WHERE u.username='owner'");
    const page1=await f.call('/api/admin','GET',undefined,owner.cookie),page2=await f.call('/api/admin?page=2','GET',undefined,owner.cookie);
    assert.equal(page1.data.users.length,20);assert.equal(page2.data.users.length,5);assert.equal(page2.data.pagination.pages,2);
  }finally{await f.db.close();}
});
