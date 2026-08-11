require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { inquiryPLN } = require('./kiosbank');

const app = express();
app.use(express.json());

const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
app.use(cors({ origin: allowedOrigin }));

// Batasi berapa banyak request Inquiry paralel ke Kiosbank pada satu waktu,
// supaya tidak membanjiri mereka saat ID pelanggan banyak.
async function processWithConcurrencyLimit(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runNext() {
    const current = nextIndex++;
    if (current >= items.length) return;
    try {
      results[current] = await worker(items[current]);
    } catch (err) {
      results[current] = {
        customerID: items[current],
        nama: null,
        daya: null,
        tarif: null,
        adminBank: null,
        sukses: false,
        rc: 'ERR',
        error: err.message,
      };
    }
    return runNext();
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, runNext);
  await Promise.all(workers);
  return results;
}

app.post('/api/cek-kolektif', async (req, res) => {
  const { customerIDs } = req.body || {};

  if (!Array.isArray(customerIDs) || customerIDs.length === 0) {
    return res.status(400).json({ error: 'customerIDs harus berupa array dan tidak boleh kosong.' });
  }

  try {
    const results = await processWithConcurrencyLimit(customerIDs, 5, (id) => inquiryPLN(id));
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Backend PLN Kolektif jalan di port ${port}`);
});
