const axios = require('axios');
const crypto = require('crypto');
const https = require('https');

// Kiosbank memakai sertifikat yang kadang tidak lolos verifikasi standar
// (lihat contoh resmi mereka: verify=False / CURLOPT_SSL_VERIFYPEER=>0).
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

const SIGN_ON_PATH = '/auth/Sign-On';
const INQUIRY_PATH = '/api/webservices/Main/Inquiry/LISTRIK';

function md5(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

// Parse header WWW-Authenticate: Digest realm="...", nonce="...", qop="...", opaque="..."
function parseDigestChallenge(headerValue) {
  const result = {};
  const withoutScheme = headerValue.replace(/^Digest\s+/i, '');
  // pisah per koma, tapi hati-hati karena value bisa mengandung koma di dalam quote (jarang untuk field ini)
  const parts = withoutScheme.split(',');
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    let value = part.slice(idx + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function buildDigestAuthorizationHeader({ username, password, method, uri, challenge }) {
  const { realm, nonce, qop, opaque } = challenge;
  const nc = '1';
  const cnonce = crypto.randomBytes(8).toString('hex');

  const ha1 = md5(`${username}:${realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  const response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`);

  const fields = [
    `username="${username}"`,
    `realm="${realm}"`,
    `nonce="${nonce}"`,
    `uri="${uri}"`,
    `qop=${qop}`,
    `nc=${nc}`,
    `cnonce="${cnonce}"`,
    `response="${response}"`,
  ];
  if (opaque) fields.push(`opaque="${opaque}"`);

  return `Digest ${fields.join(',')}`;
}

// Cache sessionID in-memory. Berlaku sampai 23:59 WIB hari yang sama.
let cachedSession = null; // { sessionID, dateStr }

function todayDateStrJakarta() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' }); // YYYY-MM-DD
}

async function requestNewSession() {
  const baseUrl = process.env.KIOSBANK_BASE_URL;
  const url = `${baseUrl}${SIGN_ON_PATH}`;
  const username = process.env.KIOSBANK_DIGEST_USERNAME;
  const password = process.env.KIOSBANK_DIGEST_PASSWORD;

  const body = {
    mitra: process.env.KIOSBANK_MITRA,
    accountID: process.env.KIOSBANK_ACCOUNT_ID,
    merchantID: process.env.KIOSBANK_MERCHANT_ID,
    merchantName: process.env.KIOSBANK_MERCHANT_NAME,
    counterID: process.env.KIOSBANK_COUNTER_ID,
  };

  // Langkah 1: request tanpa Authorization untuk memancing challenge 401
  let challengeHeader;
  try {
    await axios.post(url, {}, {
      httpsAgent,
      headers: { 'Content-Type': 'application/json' },
      validateStatus: () => true,
    }).then((res) => {
      challengeHeader = res.headers['www-authenticate'];
      if (!challengeHeader && res.status !== 401) {
        throw new Error(`Tidak menerima challenge Digest, status: ${res.status}`);
      }
    });
  } catch (err) {
    throw new Error(`Gagal mengambil digest challenge dari Kiosbank: ${err.message}`);
  }

  if (!challengeHeader) {
    throw new Error('Header WWW-Authenticate tidak ditemukan pada respons Sign On tahap 1.');
  }

  const challenge = parseDigestChallenge(challengeHeader);

  // Langkah 2: kirim ulang dengan Authorization: Digest ...
  const authHeader = buildDigestAuthorizationHeader({
    username,
    password,
    method: 'POST',
    uri: SIGN_ON_PATH,
    challenge,
  });

  const res2 = await axios.post(url, body, {
    httpsAgent,
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader,
    },
    validateStatus: () => true,
  });

  if (res2.status < 200 || res2.status >= 300) {
    throw new Error(`Sign On gagal, status ${res2.status}: ${JSON.stringify(res2.data)}`);
  }

  const sessionID = res2.data && (res2.data.SessionID || res2.data.sessionID);
  if (!sessionID) {
    throw new Error(`Response Sign On tidak berisi SessionID: ${JSON.stringify(res2.data)}`);
  }

  return sessionID;
}

async function getSessionID() {
  const today = todayDateStrJakarta();
  if (cachedSession && cachedSession.dateStr === today) {
    return cachedSession.sessionID;
  }
  const sessionID = await requestNewSession();
  cachedSession = { sessionID, dateStr: today };
  return sessionID;
}

function generateReferenceID() {
  // Harus 12 digit angka dan unik. Pakai kombinasi waktu + random.
  const ts = Date.now().toString(); // 13 digit
  const rand = Math.floor(Math.random() * 100); // 0-99
  const combined = (ts + rand.toString().padStart(2, '0')).slice(-12);
  return combined;
}

async function inquiryPLN(customerID, { forceNewSession = false } = {}) {
  const baseUrl = process.env.KIOSBANK_BASE_URL;
  const url = `${baseUrl}${INQUIRY_PATH}`;

  let sessionID = forceNewSession
    ? (cachedSession = null, await getSessionID())
    : await getSessionID();

  const body = {
    sessionID,
    merchantID: process.env.KIOSBANK_MERCHANT_ID,
    productID: process.env.KIOSBANK_PRODUCT_ID,
    customerID,
    referenceID: generateReferenceID(),
  };

  const res = await axios.post(url, body, {
    httpsAgent,
    headers: { 'Content-Type': 'application/json' },
    validateStatus: () => true,
  });

  const data = res.data || {};
  const rc = data.rc;
  const sukses = rc === '00';

  // CATATAN: mapping field di bawah ini berdasar tebakan dari contoh response
  // yang dibagikan (NM = nama pelanggan, LB = kode golongan/daya, AB = admin biaya).
  // Field "tarif" tidak terlihat eksplisit di contoh response Inquiry LISTRIK yang
  // diberikan — mohon cek kamus field lengkap dari dokumentasi Kiosbank Anda dan
  // sesuaikan mapping di bawah bila perlu.
  const inner = data.data || {};

  return {
    customerID,
    nama: inner.NM ? inner.NM.trim() : null,
    daya: inner.LB ?? null, // kode golongan daya, bukan nilai VA — cek dokumentasi
    tarif: null, // TODO: sesuaikan bila Kiosbank mengirim kode tarif terpisah
    adminBank: inner.AB ?? null, // tebakan: admin biaya
    sukses,
    rc,
    raw: data, // disertakan agar mudah didebug; hapus di produksi bila tak perlu
  };
}

module.exports = { getSessionID, inquiryPLN };
