async function renderServerProducts(sequence) {
  const node=$('#public-results');
  node.innerHTML='<p class="muted" role="status">Memuat produk...</p>';
  const query=new URLSearchParams({page:state.publicPageIndex,mode:state.filter,q:state.query,collection:state.collection || 0});
  try { const result=await api(`/api/public/${state.public.user.slug}/products?${query}`);
    if(sequence!==state.browseSequence || !node.isConnected)return;
    // Keep loaded product actions available without loading the whole catalog.
    for(const p of result.products){const index=state.public.products.findIndex(x=>x.id===p.id);if(index<0)state.public.products.push(p);else state.public.products[index]=p;}
    state.publicPageIndex=result.page;
    const title=state.query.trim() ? `${result.total} hasil untuk “${state.query}”` : ({new:'Baru ditambahkan',featured:'Rekomendasi produk',trending:'Lagi trending',collections:'Pilihan koleksi'}[state.filter] || 'Semua produk');
    const pages=Array.from({length:Math.min(result.pages,7)},(_,i)=>result.pages<=7 ? i+1 : Math.min(result.pages-6,Math.max(1,result.page-3))+i);
    node.innerHTML=`<div class="section-heading"><div><span class="kicker">${fmt(result.total)} PRODUK</span><h2>${esc(title)}</h2></div>${state.query ? '<button class="clear-search" data-clear-search>Hapus pencarian</button>' : ''}</div>${result.products.length ? `<div class="product-list">${result.products.map(p=>productCard(p,true)).join('')}</div>` : emptyState('Belum ketemu','Coba kata lain atau pilih kategori berbeda.')}${result.pages>1 ? `<nav class="product-pagination" aria-label="Halaman produk"><button data-public-page="1" ${result.page===1 ? 'disabled' : ''} aria-label="Halaman pertama">«</button><button data-public-page="${result.page-1}" ${result.page===1 ? 'disabled' : ''} aria-label="Halaman sebelumnya">‹</button>${pages.map(n=>`<button data-public-page="${n}" class="${n===result.page ? 'active' : ''}" ${n===result.page ? 'aria-current="page"' : ''}>${n}</button>`).join('')}<button data-public-page="${result.page+1}" ${result.page===result.pages ? 'disabled' : ''} aria-label="Halaman berikutnya">›</button><button data-public-page="${result.pages}" ${result.page===result.pages ? 'disabled' : ''} aria-label="Halaman terakhir">»</button></nav>` : ''}`;
  }catch(error){if(sequence===state.browseSequence && node.isConnected)node.innerHTML=emptyState('Produk belum termuat',error.message);}
}
function recoveryPage(params) {
  document.body.dataset.page='auth';
  const kind=params.has('reset') ? 'reset' : params.has('verify') ? 'verify' : 'forgot';
  const title={reset:'Password baru.',verify:'Verifikasi email.',forgot:'Lupa password?'}[kind];
  app.innerHTML=`${topbar()}<main class="recovery-page panel"><a class="back-link" href="/auth?tab=login">← Kembali ke masuk</a><h1>${title}</h1><p>${kind==='forgot' ? 'Masukkan email pemulihan yang sudah kamu verifikasi di pengaturan.' : kind==='reset' ? 'Pilih password baru. Semua perangkat akan keluar setelah perubahan.' : 'Konfirmasi untuk menjadikan email ini sebagai email pemulihan akunmu.'}</p><form id="recovery-form" class="stack-form" data-kind="${kind}"><input type="hidden" name="token" value="${esc(params.get(kind) || '')}">${kind==='forgot' ? '<label>Email<input name="email" type="email" autocomplete="email" required maxlength="254"></label>' : kind==='reset' ? '<label>Password baru<input name="password" type="password" autocomplete="new-password" required minlength="8" maxlength="128"></label>' : ''}<button type="submit" class="button button-dark">${kind==='forgot' ? 'Kirim tautan pemulihan' : kind==='reset' ? 'Simpan password' : 'Verifikasi email'}</button><p class="form-message" role="status"></p></form></main>`;
}
function appendAccountSettings(target) {
  const a=state.account || {};
  target.insertAdjacentHTML('beforeend',`<section class="panel account-settings"><span class="kicker">KEAMANAN AKUN</span><h2>Jaga akses ke halamanmu.</h2><div class="account-setting-grid"><form id="account-email-form" class="stack-form"><h3>Email pemulihan</h3><p>${a.emailVerified ? `Terverifikasi: ${esc(a.email)}` : 'Tambahkan email dan verifikasi agar kamu bisa memulihkan password.'}</p><label>Email<input name="email" type="email" value="${esc(a.email || '')}" required maxlength="254" autocomplete="email"></label><label>Password saat ini<input name="password" type="password" required autocomplete="current-password" maxlength="128"></label><button class="button button-outline" type="submit" ${!a.emailReady ? 'disabled' : ''}>Kirim verifikasi</button>${!a.emailReady ? '<small class="hint">Layanan email sedang disiapkan pengelola.</small>' : ''}<p class="form-message" role="status"></p></form><form id="account-password-form" class="stack-form"><h3>Ganti password</h3><p>Semua perangkat akan keluar setelah password diubah.</p><label>Password saat ini<input name="currentPassword" type="password" autocomplete="current-password" required maxlength="128"></label><label>Password baru<input name="password" type="password" autocomplete="new-password" required minlength="8" maxlength="128"></label><button class="button button-dark" type="submit">Ganti password</button><p class="form-message" role="status"></p></form></div></section>`);
}
async function renderBilling(target) {
  const a=state.account || {}, c=state.config;
  target.innerHTML=`<section class="panel billing-panel"><span class="kicker">PAKET AFFALINK</span><h2>${c.billing ? `Rp${fmt(c.price)}` : 'Paket sedang disiapkan.'}</h2><p>${c.billing ? `Akses selama ${c.days || '—'} hari. Pembayaran satu kali, tanpa perpanjangan otomatis.` : 'Pengelola belum membuka pembayaran. Kamu masih dapat menggunakan akun seperti biasa.'}</p><div class="access-status"><strong>${a.access ? 'Akun aktif' : 'Aktivasi diperlukan'}</strong><span>${a.activeUntil ? `Berlaku sampai ${date(a.activeUntil)} (WIB)` : c.billing ? 'Halaman publik dan pengelolaan produk aktif setelah pembayaran berhasil.' : 'Belum ada tanggal masa aktif.'}</span></div>${c.billing ? `<div class="billing-actions"><button data-checkout class="button button-dark" ${!c.paymentReady ? 'disabled' : ''}>${a.access ? 'Perpanjang paket' : 'Bayar & aktifkan'} ${icon('arrow',17)}</button><button data-refresh-payment class="button button-outline">Cek pembayaran</button></div>${!c.paymentReady ? '<p class="hint">Pembayaran sedang disiapkan pengelola.</p>' : ''}` : ''}${c.supportEmail ? `<p>Butuh bantuan? <a href="mailto:${esc(c.supportEmail)}">${esc(c.supportEmail)}</a></p>` : ''}</section><section class="panel"><h2>Riwayat pembayaran</h2><div id="payment-history"><p>Memuat riwayat...</p></div></section>`;
  try { const {orders}=await api('/api/billing'); const node=$('#payment-history',target); if(!node || !target.isConnected) return;
    const labels={created:'Disiapkan',pending:'Menunggu pembayaran',paid:'Berhasil',deny:'Ditolak',cancel:'Dibatalkan',expire:'Kedaluwarsa',failure:'Gagal'};
    node.innerHTML=orders.length ? orders.map(o=>`<div class="payment-row"><div><strong>Rp${fmt(o.amount)} · ${o.duration_days} hari</strong><small>${date(o.created_at)} · ${esc(o.id)}</small></div><span>${labels[o.status] || esc(o.status)}</span>${['created','pending'].includes(o.status) && o.checkout_url ? `<a class="button button-outline button-sm" href="${esc(o.checkout_url)}">Lanjut bayar</a>` : ''}</div>`).join('') : '<p>Belum ada pembayaran.</p>';
  } catch(error) { if(target.isConnected) $('#payment-history',target).textContent=error.message; }
}
async function renderAdmin(target) {
  target.innerHTML='<section class="panel"><h2>Memuat data admin...</h2></section>';
  try {const d=await api('/api/admin'); if(!target.isConnected || state.view!=='admin')return;
    target.innerHTML=`<section class="panel"><h2>Pengguna (${d.users.length})</h2><p>Menampilkan maksimal 200 akun terbaru.</p><div class="admin-list">${d.users.map(u=>`<div class="admin-row"><div><strong>${esc(u.display_name)}</strong><small>@${esc(u.username)} · /${esc(u.slug)}</small></div><span>${u.products} produk · ${(Number(u.storage_bytes)/1024/1024).toFixed(1)} MB</span><span>${u.active_until ? `Aktif sampai ${date(u.active_until)}` : 'Belum ada masa aktif'}</span></div>`).join('')}</div></section><section class="panel"><h2>Pembayaran terbaru</h2>${d.orders.length ? d.orders.map(o=>`<div class="payment-row"><div><strong>@${esc(o.username)} · Rp${fmt(o.amount)}</strong><small>${date(o.created_at)}</small></div><span>${esc(o.status)}</span></div>`).join('') : '<p>Belum ada transaksi.</p>'}</section>`;
  } catch(error) {target.innerHTML=emptyState('Data belum tersedia',error.message);}
}
async function uploadOptimized(input) {
  const file=input.files[0], avatar=input.id==='avatar-upload';
  if(!['image/png','image/jpeg','image/webp','image/gif'].includes(file.type) || file.size>15*1024*1024) { input.value=''; return toast('Pilih gambar JPG, PNG, WebP, atau GIF maksimal 15 MB.'); }
  const form=input.closest('form'), save=form.querySelector('[type=submit]');
  save.disabled=true; input.disabled=true;
  if(avatar) $('#avatar-status').textContent='Memproses foto...';
  let bitmap;
  try {
    bitmap=await createImageBitmap(file);
    if(bitmap.width*bitmap.height>50000000) throw Error('Resolusi gambar terlalu besar.');
    const canvas=document.createElement('canvas'), context=canvas.getContext('2d');
    if(avatar) {const size=Math.min(bitmap.width,bitmap.height);canvas.width=canvas.height=400;context.drawImage(bitmap,(bitmap.width-size)/2,(bitmap.height-size)/2,size,size,0,0,400,400);}
    else {const ratio=Math.min(1,1000/Math.max(bitmap.width,bitmap.height));canvas.width=Math.max(1,Math.round(bitmap.width*ratio));canvas.height=Math.max(1,Math.round(bitmap.height*ratio));context.drawImage(bitmap,0,0,canvas.width,canvas.height);}
    let data=canvas.toDataURL('image/webp',.82);
    if(data.length>2700000) data=canvas.toDataURL('image/jpeg',.65);
    if(data.length>2700000) throw Error('Gambar masih terlalu besar. Pilih gambar lain.');
    const r=await api('/api/upload',{method:'POST',body:JSON.stringify({data})});
    if(!form.isConnected) return;
    form.elements[avatar ? 'avatarUrl' : 'imageUrl'].value=r.url;
    if(avatar) { const preview=image(r.url,state.dashboard.user.displayName,'avatar-image');$('#profile-avatar-preview').innerHTML=preview; const aside=$('.profile-preview .profile-avatar');if(aside)aside.innerHTML=preview;$('#avatar-status').textContent='Foto dipotong persegi dari tengah. Klik Simpan perubahan.'; }
    else $('#product-image-preview').innerHTML=image(r.url,'Pratinjau produk');
    toast('Gambar diperkecil dan berhasil diunggah.');
  } catch(error) {toast(error.message || 'Gambar tidak bisa diproses.');if(avatar && form.isConnected)$('#avatar-status').textContent='Foto belum berhasil diunggah.';}
  finally {bitmap?.close();save.disabled=false;input.disabled=false;input.value='';}
}
document.addEventListener('click',async e=>{
  const toggle=e.target.closest('[data-toggle-product]'), duplicate=e.target.closest('[data-duplicate-product]');
  if(toggle || duplicate) {
    const button=toggle || duplicate;button.disabled=true;
    try {if(toggle){const p=state.dashboard.products.find(p=>p.id===Number(toggle.dataset.toggleProduct));await api(`/api/products/${p.id}/visibility`,{method:'PUT',body:JSON.stringify({visible:p.visible===false})});}
      else await api(`/api/products/${duplicate.dataset.duplicateProduct}/duplicate`,{method:'POST'});
      await refreshDashboard();toast(duplicate ? 'Salinan dibuat dalam kondisi disembunyikan.' : 'Status produk diperbarui.');
    }catch(error){toast(error.message);button.disabled=false;}
  }
  const checkout=e.target.closest('[data-checkout]');if(checkout){checkout.disabled=true;try{const r=await api('/api/billing/checkout',{method:'POST'});location.assign(r.url);}catch(error){toast(error.message);checkout.disabled=false;}}
  const refresh=e.target.closest('[data-refresh-payment]');if(refresh){refresh.disabled=true;try{await api('/api/billing/refresh',{method:'POST'});await refreshDashboard();toast('Status pembayaran diperbarui.');}catch(error){toast(error.message);refresh.disabled=false;}}
});
document.addEventListener('change',async e=>{if(e.target.id==='stats-period'){state.statsDays=e.target.value;try{await refreshDashboard();}catch(error){toast(error.message);}}});
document.addEventListener('input',e=>{if(e.target.name==='imageUrl' && e.target.closest('#product-form'))$('#product-image-preview').innerHTML=image(e.target.value,'Pratinjau produk');});
document.addEventListener('submit',async e=>{
  const form=e.target, id=form.id;
  if(!['recovery-form','account-email-form','account-password-form'].includes(id))return;
  e.preventDefault();const button=form.querySelector('[type=submit]'),message=$('.form-message',form);button.disabled=true;message.textContent='Memproses...';
  try{const values=Object.fromEntries(new FormData(form));const route=id==='recovery-form' ? `/api/account/${form.dataset.kind}` : id==='account-email-form' ? '/api/account/email' : '/api/account/password';
    const r=await api(route,{method:'POST',body:JSON.stringify(values)});
    if(id==='account-password-form' || form.dataset.kind==='reset'){state.me=null;state.dashboard=null;navigate('/auth?tab=login');toast('Password tersimpan. Silakan masuk kembali.');}
    else {message.textContent=r.message || 'Email berhasil diverifikasi.';button.disabled=false;form.querySelector('input[type=password]')?.value && (form.querySelector('input[type=password]').value='');}
  }catch(error){message.textContent=error.message;button.disabled=false;}
});
