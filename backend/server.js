const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public'), { etag: false, lastModified: false,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
}));

app.get('/health', (_req, res) => res.json({ ok: true }));

// Terima batch event dari perangkat. on conflict do nothing = anti dobel.
app.post('/sync', async (req, res) => {
  const events = Array.isArray(req.body && req.body.events) ? req.body.events : [];
  if (!events.length) return res.json({ ok: true, received: 0 });

  const client = await pool.connect();
  try {
    await client.query('begin');
    const sql = `insert into scan_event (id, tenant_id, barcode, scanned_at)
                 values ($1, $2, $3, $4)
                 on conflict (id) do nothing`;
    for (const e of events) {
      if (!e || !e.id || !e.barcode) continue;
      await client.query(sql, [e.id, e.tenant_id, e.barcode, e.scanned_at]);
    }
    await client.query('commit');
    res.json({ ok: true, received: events.length });
  } catch (err) {
    await client.query('rollback');
    console.error('sync failed:', err.message);
    res.status(500).json({ ok: false, error: 'sync_failed' });
  } finally {
    client.release();
  }
});

// Counting per item, hasil agregasi event + nama dari master (kalau ada).
app.get('/counts', async (req, res) => {
  const tenant = req.query.tenant_id || null;
  try {
    const { rows } = await pool.query(
      `select s.tenant_id, s.barcode, count(*)::int as qty, p.product_name
         from scan_event s
         left join products p on p.barcode = s.barcode
        where ($1::text is null or s.tenant_id = $1)
        group by s.tenant_id, s.barcode, p.product_name
        order by qty desc`,
      [tenant]
    );
    res.json({ ok: true, counts: rows });
  } catch (err) {
    console.error('counts failed:', err.message);
    res.status(500).json({ ok: false, error: 'query_failed' });
  }
});

const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const DEFAULT_PIN_HASH = '03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4';

// Verifikasi PIN admin.
app.post('/admin/verify-pin', async (req, res) => {
  const { pin } = req.body || {};
  if (!pin) return res.status(400).json({ ok: false, error: 'PIN wajib diisi' });
  try {
    const { rows } = await pool.query("select value from settings where key='admin_pin_hash'");
    const stored = rows[0]?.value || DEFAULT_PIN_HASH;
    res.json({ ok: sha256(pin) === stored });
  } catch (err) {
    console.error('verify-pin failed:', err.message);
    res.status(500).json({ ok: false, error: 'query_failed' });
  }
});

// Ganti PIN admin (perlu PIN lama yang benar).
app.post('/admin/change-pin', async (req, res) => {
  const { current_pin, new_pin } = req.body || {};
  if (!current_pin || !new_pin) return res.status(400).json({ ok: false, error: 'PIN lama dan baru wajib diisi' });
  if (!/^\d{4,8}$/.test(String(new_pin))) return res.status(400).json({ ok: false, error: 'PIN baru harus 4-8 digit angka' });
  try {
    const { rows } = await pool.query("select value from settings where key='admin_pin_hash'");
    const stored = rows[0]?.value || DEFAULT_PIN_HASH;
    if (sha256(current_pin) !== stored) return res.status(403).json({ ok: false, error: 'PIN lama salah' });
    await pool.query(
      "insert into settings(key,value) values('admin_pin_hash',$1) on conflict(key) do update set value=$1",
      [sha256(new_pin)]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('change-pin failed:', err.message);
    res.status(500).json({ ok: false, error: 'query_failed' });
  }
});

// Daftar semua tenant.
app.get('/tenants', async (_req, res) => {
  try {
    const { rows } = await pool.query('select tenant_id, name from tenants order by tenant_id');
    res.json({ ok: true, tenants: rows });
  } catch (err) {
    console.error('tenants failed:', err.message);
    res.status(500).json({ ok: false, error: 'query_failed' });
  }
});

// Tambah tenant baru.
app.post('/tenants', async (req, res) => {
  const { tenant_id, name } = req.body || {};
  if (!tenant_id || !/^[A-Za-z0-9_-]{1,30}$/.test(tenant_id))
    return res.status(400).json({ ok: false, error: 'tenant_id tidak valid (maks 30 karakter alfanumerik)' });
  try {
    await pool.query(
      'insert into tenants (tenant_id, name) values ($1, $2)',
      [tenant_id.trim(), (name || tenant_id).trim()]
    );
    res.json({ ok: true });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ ok: false, error: 'tenant_id sudah ada' });
    console.error('add tenant failed:', err.message);
    res.status(500).json({ ok: false, error: 'query_failed' });
  }
});

// Reset semua scan count untuk satu tenant.
app.delete('/tenants/:id/counts', async (req, res) => {
  try {
    const r = await pool.query('delete from scan_event where tenant_id=$1', [req.params.id]);
    res.json({ ok: true, deleted: r.rowCount });
  } catch (err) {
    console.error('reset counts failed:', err.message);
    res.status(500).json({ ok: false, error: 'query_failed' });
  }
});

// Hapus tenant.
app.delete('/tenants/:id', async (req, res) => {
  try {
    const r = await pool.query('delete from tenants where tenant_id=$1', [req.params.id]);
    if (r.rowCount === 0) return res.status(404).json({ ok: false, error: 'tidak ditemukan' });
    res.json({ ok: true });
  } catch (err) {
    console.error('delete tenant failed:', err.message);
    res.status(500).json({ ok: false, error: 'query_failed' });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log('API berjalan di port ' + port));
