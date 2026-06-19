-- Log event scan. Idempotent: id dibuat di perangkat, insert ulang aman.
create table if not exists scan_event (
  id          uuid primary key,
  tenant_id   text        not null,
  barcode     text        not null,
  scanned_at  timestamptz not null,
  synced_at   timestamptz not null default now()
);

create index if not exists idx_scan_event_tenant_barcode
  on scan_event (tenant_id, barcode);

-- Master produk. Di production pakai tabel products milikmu yang sudah ada;
-- ini dibuat agar demo docker-compose berjalan mandiri. Kuncinya: barcode.
create table if not exists products (
  product_id     text,
  product_name   text,
  barcode        text primary key,
  stock_quantity integer,
  tenant_id      text,
  description     text
);

-- Konfigurasi aplikasi (key-value).
create table if not exists settings (
  key   text primary key,
  value text not null
);
-- PIN admin default: 1234 (SHA-256)
insert into settings (key, value) values
  ('admin_pin_hash', '03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4')
on conflict (key) do nothing;

-- Daftar tenant yang terdaftar.
create table if not exists tenants (
  tenant_id   text primary key,
  name        text not null,
  created_at  timestamptz not null default now()
);

insert into tenants (tenant_id, name) values
  ('D07', 'D07'),
  ('D08', 'D08'),
  ('D09', 'D09')
on conflict (tenant_id) do nothing;

-- Contoh master agar join terlihat hasilnya (boleh dihapus).
insert into products (product_id, product_name, barcode, tenant_id) values
  ('P-001', 'Mainan Robot A',   '8991234567890', 'D07'),
  ('P-002', 'Boneka Beruang',   '8997011611001', 'D07')
on conflict (barcode) do nothing;
