const escape = value => String(value || '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function withMetadata(html,user,origin) {
  if(!user) return html;
  const title=`${user.display_name} | Affalink`,description=user.bio || `Temukan rekomendasi pilihan ${user.display_name} di Affalink.`, canonical=`${origin}/${user.slug}`;
  let image=`${origin}/assets/affalink-3d.png`;
  try { const avatar=new URL(user.avatar_url,origin);if(user.avatar_url && ['http:','https:'].includes(avatar.protocol))image=avatar.href; }catch{}
  const meta=`<link rel="canonical" href="${escape(canonical)}"><meta property="og:type" content="website"><meta property="og:site_name" content="Affalink"><meta property="og:title" content="${escape(title)}"><meta property="og:description" content="${escape(description)}"><meta property="og:url" content="${escape(canonical)}"><meta property="og:image" content="${escape(image)}"><meta name="twitter:card" content="summary"><meta name="twitter:title" content="${escape(title)}"><meta name="twitter:description" content="${escape(description)}"><meta name="twitter:image" content="${escape(image)}">`;
  return html.replace(/<title>[\s\S]*?<\/title>/,`<title>${escape(title)}</title>`).replace(/<meta name="description"[^>]*>/,`<meta name="description" content="${escape(description)}">`).replace('</head>',`${meta}</head>`);
}
