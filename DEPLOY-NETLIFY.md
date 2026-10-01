# Deploy Affalink dengan Supabase + Netlify

GitHub menyimpan source, Netlify menjalankan halaman dan API, Supabase menyimpan akun, produk, statistik, serta gambar. GitHub Pages sendiri tidak dapat menjalankan API login dan database.

## 1. Siapkan Supabase

1. Buat proyek Supabase baru.
2. Buka **SQL Editor**, lalu jalankan seluruh isi `supabase/schema.sql` satu kali. Skrip ini membuat tabel dan mengaktifkan Row Level Security. Aplikasi mengakses tabel hanya melalui Netlify Function; tidak ada akses langsung dari browser ke database.
3. Buka **Storage** → buat bucket bernama persis `product-images`. Jadikan bucket **Public** agar gambar produk di halaman publik bisa dibuka. Batasi ukuran file menjadi 2 MB dan MIME type ke `image/png`, `image/jpeg`, `image/webp`, `image/gif` bila pengaturan itu tersedia. Unggahan tetap melalui API yang memeriksa sesi pengguna.
4. Dari dialog **Connect**, salin connection string **Transaction pooler** (port 6543), termasuk nama user, password, dan `sslmode=require`. Salin juga Project URL dan **secret key** dari Settings → API Keys. Simpan nilainya di pengaturan environment Netlify, bukan di repo.

## 2. Hubungkan GitHub ke Netlify

1. Unggah isi proyek ke repositori GitHub. `.gitignore` sudah mengecualikan `.env`, `data/`, `uploads/`, dan `node_modules/`.
2. Di Netlify, buat site dari repositori itu. `netlify.toml` sudah menetapkan build command, publish directory `public`, serta Functions dan routing.
3. Set environment variables berikut untuk **Functions**:

   | Nama | Isi |
   | --- | --- |
   | `SUPABASE_DB_URL` | Transaction pooler connection string Supabase |
   | `SUPABASE_URL` | Project URL, contoh `https://xxxxx.supabase.co` |
   | `SUPABASE_SECRET_KEY` | Secret key (`sb_secret_...`), hanya di server |
   | `AWS_LAMBDA_JS_RUNTIME` | `nodejs24.x` |

   Untuk verifikasi identitas server database, Anda juga dapat menambahkan `SUPABASE_DB_CA` berisi sertifikat CA dari **Supabase → Database Settings → SSL Configuration → Download Certificate**. Isi dapat berupa PEM dengan baris baru asli atau `\n` literal. Tanpa variabel ini koneksi tetap memakai TLS terenkripsi, tetapi sertifikat server tidak diverifikasi. Jangan menonaktifkan TLS atau mengatur `NODE_TLS_REJECT_UNAUTHORIZED` secara global.

4. Deploy ulang setelah environment tersimpan. Uji daftar akun, slug unik, login, unggah gambar, produk, halaman publik, dan statistik. Atur domain sendiri di Netlify jika diperlukan.

`SUPABASE_SECRET_KEY` memberi hak istimewa. Jangan memasukkannya ke file source, variabel publik, atau browser. Jika gagal koneksi database, periksa password connection string dan pengaturan SSL. Jika unggah gagal, periksa nama bucket, status Public, Project URL, dan secret key.

## Berkas ZIP

`Affalink-Netlify-source.zip` berisi source yang dapat diekstrak lalu diunggah ke GitHub. ZIP ini bukan pengganti konfigurasi Supabase dan environment variables. Drag-and-drop folder `public/` saja tidak akan menjalankan API.

SQLite lokal di `data/affilink.sqlite` hanya untuk pratinjau `npm start`. Data lokal tidak otomatis berpindah ke Supabase. Alamat `affalink.web` di contoh memerlukan domain yang dimiliki dan diarahkan ke Netlify; alamat bawaan Netlify juga dapat dipakai.
