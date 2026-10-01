function chooseAvatarCrop(bitmap) {
  return new Promise(resolve=>{
    const root=document.createElement('div');root.id='avatar-crop-root';
    root.innerHTML=`<div class="modal-backdrop"><section class="modal modal-small" role="dialog" aria-modal="true" aria-labelledby="crop-title"><div class="modal-header"><h2 id="crop-title">Atur foto profil</h2><button type="button" data-crop-cancel class="modal-close" aria-label="Batal">${icon('close',20)}</button></div><div class="modal-form"><canvas id="crop-preview" width="280" height="280" aria-label="Pratinjau potongan foto"></canvas><p class="hint">Geser posisi dan zoom agar wajah pas di dalam foto.</p><label>Zoom<input type="range" id="crop-zoom" min="1" max="3" step="0.05" value="1"></label><label>Posisi horizontal<input type="range" id="crop-x" min="0" max="100" value="50"></label><label>Posisi vertikal<input type="range" id="crop-y" min="0" max="100" value="50"></label><div class="modal-actions"><button type="button" data-crop-cancel class="button button-outline">Batal</button><button type="button" id="crop-save" class="button button-dark">Gunakan foto</button></div></div></section></div>`;
    document.body.append(root);
    app.inert=true;
    const canvas=$('#crop-preview',root),ctx=canvas.getContext('2d');let crop;
    const draw=()=>{const zoom=Number($('#crop-zoom',root).value),size=Math.min(bitmap.width,bitmap.height)/zoom;const x=Number($('#crop-x',root).value);const y=Number($('#crop-y',root).value);crop={size,x:(bitmap.width-size)*x/100,y:(bitmap.height-size)*y/100};ctx.clearRect(0,0,280,280);ctx.drawImage(bitmap,crop.x,crop.y,size,size,0,0,280,280);};
    // Each dialog owns its handlers so canceling cannot leave a pending upload.
    const done=value=>{window.removeEventListener('keydown',escape);app.inert=false;root.remove();resolve(value);};
    const escape=e=>{if(e.key==='Escape')done(null);};window.addEventListener('keydown',escape);
    root.addEventListener('input',draw);root.addEventListener('click',e=>{if(e.target.closest('[data-crop-cancel]') || e.target===root.firstElementChild)done(null);else if(e.target.closest('#crop-save'))done(crop);});
    draw();$('#crop-save',root).focus();
  });
}
