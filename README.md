# Affalink

Aplikasi mobile-first untuk menyimpan, mengatur, dan membagikan link affiliate melalui halaman publik milik setiap pengguna.

## Jalankan lokal

Memerlukan Node.js 24 atau lebih baru. Pasang dependensi proyek terlebih dahulu.

```bash
npm install
npm start
```

Buka `http://localhost:3000`. Halaman contoh tersedia di `/demo`. Untuk menjalankan tes:

```bash
npm test
```

## Fitur

- Daftar dan masuk dengan username serta password. Password disimpan sebagai hash scrypt.
- Setiap pengguna mendapat slug unik, misalnya `/dila`, dan dapat mengubah nama, bio, foto profil, serta slug dari dashboard.
- Tambah, edit, dan hapus produk dengan link, gambar, deskripsi, kategori, subkategori, serta tag.
- Buat koleksi dan pilih produk yang masuk ke masing-masing koleksi.
- Atur urutan rekomendasi dengan angka. Angka lebih kecil tampil lebih atas.
- Halaman publik memiliki pencarian nama, kategori, subkategori, deskripsi, dan tag; bagian produk baru, rekomendasi, koleksi, serta trending.
- Pengunjung dapat membuka, menyalin, dan membagikan link. Dashboard menghitung kunjungan dan interaksi tersebut.

## Data lokal dan deploy

Pratinjau lokal memakai SQLite di `data/affilink.sqlite` dan menyimpan gambar di `uploads/`. Atur `PORT` bila perlu. `AFFILINK_DATA_DIR` dan `AFFILINK_UPLOAD_DIR` dapat dipakai untuk memindahkan lokasi penyimpanan lokal.

Versi deploy memakai PostgreSQL Supabase untuk data, Supabase Storage untuk gambar, dan Netlify Functions untuk API. Ikuti [DEPLOY-NETLIFY.md](DEPLOY-NETLIFY.md). Database online baru dimulai kosong; data SQLite lokal tidak ikut terunggah.

Alamat `affalink.web` dalam PRD adalah contoh. Domain sebenarnya perlu dimiliki dan diarahkan ke hosting sebelum halaman publik dapat diakses dari internet.
