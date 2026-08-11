# Backend Proxy — Cek Tagihan PLN Kolektif (Kiosbank)

Backend ini dipanggil oleh halaman frontend statis Anda (`Cek Tagihan PLN Kolektif`
yang di-host di GitHub Pages). Frontend **tidak bisa** memanggil Kiosbank langsung
karena masalah CORS dan karena kredensial tidak boleh ada di sisi browser.

## Alur

1. Frontend `POST /api/cek-kolektif` dengan body `{ "customerIDs": ["...", "..."] }`.
2. Backend melakukan **Sign On** (HTTP Digest Auth, 2 tahap) ke Kiosbank, sekali per hari
   (di-cache di memory sampai pukul 23:59 WIB), lalu memakai `sessionID` yang didapat.
3. Untuk tiap `customerID`, backend memanggil **Inquiry LISTRIK** (productID `100301`)
   dengan concurrency terbatas (5 request paralel) supaya tidak membanjiri Kiosbank.
4. Backend membalas `{ "results": [ {customerID, nama, daya, tarif, adminBank, sukses, rc}, ... ] }`
   — persis format yang sudah diharapkan oleh frontend Anda.

## Setup

```bash
npm install
cp .env.example .env
# lalu edit .env, isi semua kredensial Kiosbank yang sebenarnya
npm start
```

Server akan jalan di `http://localhost:3000` (atau `PORT` di `.env`).

## Deploy

GitHub Pages hanya bisa serve file statis, jadi backend ini perlu dihosting
terpisah, misalnya:

- **Render.com** / **Railway.app** — gratis untuk mulai, tinggal connect repo.
- VPS sendiri (pakai `pm2` supaya server tetap jalan).

Setelah deploy, isi kolom **"URL Endpoint Backend"** di halaman frontend Anda
dengan URL backend ini, contoh: `https://nama-app-anda.onrender.com/api/cek-kolektif`
— **bukan** URL Kiosbank secara langsung.

## Yang perlu Anda cek/sesuaikan

1. **Kredensial** di `.env` — username/password Digest Auth, `merchantID`,
   `accountID`, `merchantName`, `counterID` — semua ini nilainya ditentukan oleh
   KIOSBANK, minta ke tim mereka jika belum punya.
2. **Mapping field respons** di `kiosbank.js` (fungsi `inquiryPLN`) — saya
   mapping `NM` → nama, `LB` → daya, `AB` → adminBank berdasarkan contoh respons
   yang Anda bagikan, tapi field `tarif` tidak terlihat eksplisit di contoh itu.
   Cek kamus field lengkap dari dokumentasi Kiosbank Anda dan sesuaikan.
3. **Batas Sign On**: maksimal 99x/hari. Karena sudah di-cache per hari, ini
   seharusnya aman kecuali server restart berkali-kali dalam sehari (tiap restart
   akan Sign On ulang karena cache in-memory hilang). Kalau butuh lebih tahan
   lama, ganti cache in-memory ini dengan file/database kecil.
4. **CORS**: set `ALLOWED_ORIGIN` di `.env` ke domain GitHub Pages Anda persis
   (`https://appabsku.github.io`) supaya hanya frontend Anda yang boleh akses.
