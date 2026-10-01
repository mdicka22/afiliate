# Mengaktifkan paket Affalink Rp50.000

Kode pembayaran sudah tersedia. Pembayaran sungguhan belum aktif sebelum kamu mengatur akun Midtrans dan environment Netlify. Harga dikunci di server sebesar Rp50.000; browser tidak bisa mengubah nominal.

## 1. Pilih masa aktif dan akun admin

Tentukan `PLAN_DURATION_DAYS`, misalnya `30` untuk 30 hari. Belum ada durasi default agar paket tidak dijual dengan masa aktif yang belum kamu pilih.

Isi `ADMIN_USERNAMES` dengan username akun kamu yang sudah terdaftar. Bisa beberapa akun, pisahkan dengan koma. Nilai ini hanya di environment server. Mengganti nama tampilan atau slug tidak memberikan akses admin.

## 2. Uji Midtrans Sandbox

1. Buka dashboard Midtrans dalam mode Sandbox, lalu **Settings → Access Keys**. Salin **Server Key** ke environment Netlify `MIDTRANS_SERVER_KEY`, centang **Contains secret values**. Client Key tidak diperlukan karena checkout memakai halaman Midtrans.
2. Tambahkan environment berikut di Netlify untuk Functions dan Production deploy:

   | Key | Value |
   | --- | --- |
   | `SITE_URL` | `https://affalink.netlify.app` |
   | `PLAN_DURATION_DAYS` | Jumlah hari yang kamu pilih |
   | `MIDTRANS_PRODUCTION` | `false` selama pengujian |
   | `BILLING_ENABLED` | `true` hanya setelah semua pengaturan siap |
   | `ADMIN_USERNAMES` | Username akun admin yang sudah ada |
   | `SUPPORT_EMAIL` | Email bantuan yang bisa dihubungi |

3. Dalam **Settings → Payment**, isi **Payment Notification URL** dengan `https://affalink.netlify.app/api/billing/webhook` dan Finish Redirect URL dengan `https://affalink.netlify.app/app?payment=return`.
4. Simpan environment dan deploy ulang di Netlify. Migrasi `supabase/upgrade.sql` berjalan otomatis saat API pertama dipakai. Jangan menjalankan ulang `schema.sql` pada database yang sudah terisi. Upgrade hanya menambah tabel/kolom dan aman dijalankan ulang.
5. Masuk memakai akun pengujian, buka **Paket**, klik **Bayar & aktifkan**, lalu gunakan simulator Sandbox Midtrans. Jangan memakai uang sungguhan untuk tes Sandbox.
6. Setelah pembayaran simulasi berhasil, akun mendapat masa aktif. Bila notifikasi belum tiba, tombol **Cek pembayaran** memeriksa status langsung dari Midtrans. Halaman selesai bayar di browser sendiri tidak mengaktifkan akun.
7. Uji pembayaran gagal dan kedaluwarsa: akun tidak boleh aktif. Notifikasi berulang untuk pesanan yang sama tidak memperpanjang dua kali. Perpanjangan yang sudah dibayar menambah masa aktif dari tanggal akhir paket saat ini, atau dari sekarang jika paket lama sudah berakhir.

**Akun yang sudah ada:** saat `BILLING_ENABLED=true`, akun tanpa `active_until` tidak memiliki akses berbayar. Akun admin tetap bisa bekerja. Tentukan dulu masa aktif/gratis untuk pengguna lama sebelum membuka billing. Jika kamu ingin memberi masa aktif kepada akun tertentu, lakukan sekali lewat SQL Editor dengan username yang benar:

```sql
UPDATE users
SET active_until = NOW() + INTERVAL '30 days'
WHERE username = 'ganti_dengan_username_yang_disetujui';
```

Ini tindakan admin, bukan bukti pembayaran. Jangan jalankan untuk semua pengguna tanpa keputusanmu.

## 3. Buka pembayaran sungguhan

Setelah Sandbox berhasil dan akun merchant Midtrans siap Production, ganti Server Key dengan key Production, set `MIDTRANS_PRODUCTION=true`, atur Payment Notification URL di dashboard Production, lalu deploy ulang. Pastikan durasi paket dan email bantuan benar. Pembayaran berupa transaksi satu kali; tidak ada auto debit atau perpanjangan otomatis.

Untuk saat ini refund harus ditangani oleh pengelola di Midtrans dan masa aktif akun ditinjau oleh admin. Pembatalan/refund setelah status sukses belum otomatis mencabut akses.

## Panel admin (poin 8)

Setelah `ADMIN_USERNAMES` berisi username akun yang sudah ada, menu **Admin** muncul. Panel ini menyediakan:

- Ringkasan pengguna, paket aktif, total pembayaran berhasil, dan ukuran unggahan yang tercatat.
- Status konfigurasi Midtrans, email, Storage, dan sertifikat TLS. Indikator menunjukkan konfigurasi tersedia, bukan tes koneksi langsung.
- Pencarian pengguna atau ID pesanan; filter akun aktif, berakhir, tanpa masa aktif, dan ditangguhkan; filter status pembayaran.
- Daftar pengguna dan pembayaran dengan 20 baris per halaman, sehingga akun lama tetap dapat ditemukan.
- Tambah masa aktif manual 1–3650 hari dengan alasan wajib. Tindakan ini tidak membuat catatan pembayaran palsu.
- Tangguhkan atau pulihkan akun tanpa menghapus produknya. Penangguhan mengeluarkan semua sesi, menolak login/checkout, dan menonaktifkan halaman publik. Akun admin tidak dapat ditangguhkan dari panel.
- Riwayat 20 tindakan admin terakhir, berisi pelaku, pengguna sasaran, alasan, dan perubahan sebelum/sesudah.

Data Storage hanya mencakup unggahan setelah fitur pencatatan aktif. File yang sudah ada sebelum upgrade dan file tidak terpakai belum otomatis dihapus. Jika ingin meninjau pembayaran refund, gunakan dashboard Midtrans sebagai sumber status keuangannya.

## 4. Email pemulihan

Integrasi pengiriman menggunakan Resend. Verifikasi domain pengirim di Resend, lalu isi `RESEND_API_KEY` sebagai secret dan `EMAIL_FROM`, misalnya `Affalink <akun@domainkamu.com>`. Deploy ulang.

Setelah itu pengguna dapat membuka **Pengaturan → Keamanan akun**, mengisi email dan password saat ini, lalu membuka tautan verifikasi. Email baru mulai menjadi email pemulihan setelah diverifikasi. Link verifikasi dan reset berlaku 30 menit dan hanya sekali pakai. Reset/ganti password mengeluarkan semua sesi pengguna. Pengguna lama perlu menambahkan email melalui pengaturan karena akun sebelumnya hanya memiliki username.

Tanpa konfigurasi layanan email, ganti password tetap tersedia, tetapi pengiriman email verifikasi/pemulihan belum dapat digunakan. Tautan reset tidak ditampilkan di API atau log.

## 5. Sertifikat database

Unduh CA dari **Supabase → Database Settings → SSL Configuration → Download Certificate**. Isi `SUPABASE_DB_CA` di Netlify dengan seluruh isi PEM (termasuk BEGIN/END CERTIFICATE), lalu set `SUPABASE_REQUIRE_VERIFIED_TLS=true` dan deploy ulang. Jika flag tersebut true tanpa CA, aplikasi menolak koneksi.

Koneksi lama tetap terenkripsi, tetapi tanpa CA belum memverifikasi sertifikat. Jangan mengaktifkan flag sebelum sertifikat yang benar tersedia, karena login akan gagal. Tidak perlu memasukkan password/secret key ke chat atau GitHub.

## Catatan fitur

- Tab Semua tetap rekomendasi kecil + 10 produk terbaru dalam slide horizontal. Lihat semua dan pencarian mengambil enam produk per halaman dari database.
- Produk yang disembunyikan tidak keluar di pencarian, koleksi publik, atau tracking produk. Duplikat dibuat tersembunyi agar bisa diedit dahulu.
- Statistik 7/30 hari mencakup pengunjung unik berbasis cookie, share halaman, dan produk teratas untuk periode tersebut. Data lama tanpa identitas cookie tidak dapat dihitung ulang sebagai pengunjung unik. Statistik harian menggunakan WIB; klik bukan penjualan atau komisi.
- Gambar input maksimal 15 MB diperkecil menjadi WebP sebelum unggah; server tetap membatasi setiap gambar menjadi 2 MB. Foto profil dapat diatur zoom serta posisi horizontal/vertikal sebelum dipotong. Membatalkan dialog tidak mengunggah foto. GIF menjadi gambar diam. Batas kumulatif unggahan baru per akun 100 MB; ini menghitung semua file yang pernah diunggah sejak upgrade, termasuk yang belum digunakan. Penghapusan file Storage lama belum otomatis.
- Pratinjau link memiliki judul, bio, dan foto profil melalui HTML dari server. Aplikasi chat dapat menyimpan pratinjau dalam cache sehingga perubahan tidak selalu muncul langsung.

Referensi integrasi: [Midtrans Snap](https://docs.midtrans.com/docs/snap-snap-integration-guide), [notifikasi Midtrans](https://docs.midtrans.com/docs/https-notification-webhooks), [Resend email API](https://resend.com/docs/api-reference/emails/send-email), [Supabase SSL](https://supabase.com/docs/guides/platform/ssl-enforcement).
