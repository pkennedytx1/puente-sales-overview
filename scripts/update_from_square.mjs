#!/usr/bin/env node
/**
 * Pull Puente sales from Square Reporting API, write CSVs, and embed DATA in index.html.
 * Uses SQUARE_ACCESS_TOKEN from ../process-payroll/.env (or env).
 */
import fs from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PULL_DATE = '2026-10-05';
const DATE_START = '2024-01-11';
const DATE_END = PULL_DATE;

dotenv.config({ path: path.resolve(ROOT, '../process-payroll/.env') });
const token = process.env.SQUARE_ACCESS_TOKEN;
if (!token) {
  console.error('Missing SQUARE_ACCESS_TOKEN (expected in ../process-payroll/.env)');
  process.exit(1);
}

function postReporting(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(
      {
        hostname: 'connect.squareup.com',
        path: '/reporting/v1/load',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          try {
            const json = JSON.parse(buf);
            if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
            else reject(new Error(json.error || json.errors?.[0]?.detail || buf));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function loadAll(query, pageSize = 10000) {
  let offset = 0;
  const all = [];
  while (true) {
    const json = await postReporting({ query: { ...query, limit: pageSize, offset } });
    if (json.error) throw new Error(json.error);
    const batch = json.data || [];
    all.push(...batch);
    if (batch.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function monthKey(iso) {
  return iso.slice(0, 7);
}

function csvEscape(v) {
  const s = String(v);
  return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCsv(filePath, header, rows) {
  const lines = [header.join(',')];
  for (const row of rows) lines.push(row.map(csvEscape).join(','));
  fs.writeFileSync(filePath, lines.join('\n') + '\n');
}

const LOCATION_META = {
  'Puente Coffee Co.': { type: 'Flagship (physical)', status: 'ACTIVE' },
  'Pop Up Coffee Stand': { type: 'Mobile pilot (Sept 2024 only)', status: 'INACTIVE' },
};

const DAY_ORDER = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

async function main() {
  const [lifetimeRow, byLocation, monthlyRaw, daypartRaw, itemsRaw, categoriesRaw] = await Promise.all([
    loadAll({
      measures: [
        'Sales.net_sales',
        'Sales.total_sales_amount',
        'Sales.order_count',
        'Sales.avg_net_sales',
        'Sales.unique_customers',
      ],
      timeDimensions: [{ dimension: 'Sales.local_reporting_timestamp', dateRange: [DATE_START, DATE_END] }],
    }),
    loadAll({
      measures: [
        'Sales.net_sales',
        'Sales.total_sales_amount',
        'Sales.order_count',
        'Sales.avg_net_sales',
        'Sales.unique_customers',
      ],
      dimensions: ['Sales.location_name'],
      timeDimensions: [{ dimension: 'Sales.local_reporting_timestamp', dateRange: [DATE_START, DATE_END] }],
    }),
    loadAll({
      measures: ['Sales.net_sales', 'Sales.total_sales_amount', 'Sales.order_count', 'Sales.avg_net_sales'],
      dimensions: ['Sales.location_name'],
      timeDimensions: [
        {
          dimension: 'Sales.local_reporting_timestamp',
          dateRange: [DATE_START, DATE_END],
          granularity: 'month',
        },
      ],
    }),
    loadAll({
      measures: ['Sales.net_sales', 'Sales.order_count'],
      dimensions: ['Sales.local_day_of_week', 'Sales.local_hour'],
      timeDimensions: [{ dimension: 'Sales.local_reporting_timestamp', dateRange: [DATE_START, DATE_END] }],
    }),
    loadAll({
      measures: ['ItemSales.item_net_sales', 'ItemSales.sales_quantity'],
      dimensions: ['ItemSales.item_name', 'ItemSales.category_name'],
      timeDimensions: [{ dimension: 'ItemSales.local_reporting_timestamp', dateRange: [DATE_START, DATE_END] }],
    }),
    loadAll({
      measures: ['ItemSales.item_net_sales'],
      dimensions: ['ItemSales.category_name'],
      timeDimensions: [{ dimension: 'ItemSales.local_reporting_timestamp', dateRange: [DATE_START, DATE_END] }],
    }),
  ]);

  const locations = byLocation.map((row) => ({
    location: row['Sales.location_name'],
    net_sales: round2(row['Sales.net_sales']),
    total_sales_amount: round2(row['Sales.total_sales_amount']),
    order_count: row['Sales.order_count'],
    avg_order_value: round2(row['Sales.avg_net_sales']),
    unique_customers: row['Sales.unique_customers'],
    ...LOCATION_META[row['Sales.location_name']],
  }));

  const lifetimeApi = lifetimeRow[0] || {};
  const lifetime = {
    net_sales: round2(lifetimeApi['Sales.net_sales']),
    total_sales: round2(lifetimeApi['Sales.total_sales_amount']),
    order_count: lifetimeApi['Sales.order_count'],
    avg_order_value: round2(lifetimeApi['Sales.avg_net_sales']),
    unique_customers: lifetimeApi['Sales.unique_customers'],
  };

  const monthlyMap = new Map();
  let popupRow = null;
  for (const row of monthlyRaw) {
    const loc = row['Sales.location_name'];
    const month = monthKey(row['Sales.local_reporting_timestamp.month'] || row['Sales.local_reporting_timestamp']);
    const entry = {
      month,
      location: loc,
      net_sales: round2(row['Sales.net_sales']),
      total_sales: round2(row['Sales.total_sales_amount']),
      order_count: row['Sales.order_count'],
      avg_order_value: round2(row['Sales.avg_net_sales']),
    };
    monthlyMap.set(`${month}|${loc}`, entry);
    if (loc === 'Pop Up Coffee Stand') popupRow = entry;
  }

  const flagshipMonths = [];
  for (let y = 2024; y <= 2026; y++) {
    for (let m = 1; m <= 12; m++) {
      const key = `${y}-${String(m).padStart(2, '0')}`;
      if (key < '2024-01' || key > '2026-10') continue;
      const found = monthlyMap.get(`${key}|Puente Coffee Co.`);
      flagshipMonths.push(
        found || {
          month: key,
          location: 'Puente Coffee Co.',
          net_sales: 0,
          total_sales: 0,
          order_count: 0,
          avg_order_value: 0,
        }
      );
    }
  }

  const monthlyCsvRows = [
    ...flagshipMonths.map((r) => [
      r.month,
      r.location,
      r.net_sales,
      r.total_sales,
      r.order_count,
      r.avg_order_value,
    ]),
  ];
  if (popupRow) {
    monthlyCsvRows.push([
      popupRow.month,
      popupRow.location,
      popupRow.net_sales,
      popupRow.total_sales,
      popupRow.order_count,
      popupRow.avg_order_value,
    ]);
  }

  writeCsv(
    path.join(ROOT, 'puente_summary.csv'),
    [
      'scope',
      'location',
      'location_type',
      'status',
      'net_sales_usd',
      'total_sales_usd',
      'order_count',
      'avg_order_value_usd',
      'unique_customers',
    ],
    [
      [
        'lifetime_all_locations',
        'All locations',
        '-',
        '-',
        lifetime.net_sales,
        lifetime.total_sales,
        lifetime.order_count,
        lifetime.avg_order_value,
        lifetime.unique_customers,
      ],
      ...locations.map((l) => [
        'by_location',
        l.location,
        l.type,
        l.status,
        l.net_sales,
        l.total_sales_amount,
        l.order_count,
        l.avg_order_value,
        l.unique_customers,
      ]),
    ]
  );

  writeCsv(
    path.join(ROOT, 'puente_monthly_sales.csv'),
    ['month', 'location', 'net_sales_usd', 'total_sales_usd', 'order_count', 'avg_order_value_usd'],
    monthlyCsvRows
  );

  const daypartSorted = daypartRaw
    .map((row) => ({
      day: row['Sales.local_day_of_week'],
      hour: row['Sales.local_hour'],
      net_sales: round2(row['Sales.net_sales']),
      order_count: row['Sales.order_count'],
    }))
    .sort((a, b) => b.net_sales - a.net_sales);

  writeCsv(
    path.join(ROOT, 'puente_daypart_sales.csv'),
    ['day_of_week', 'hour_local', 'net_sales_usd', 'order_count'],
    daypartSorted.map((r) => [r.day, r.hour, r.net_sales, r.order_count])
  );

  const topItems = itemsRaw
    .map((row) => ({
      item: row['ItemSales.item_name'],
      category: row['ItemSales.category_name'] || 'Uncategorized',
      net_sales: round2(row['ItemSales.item_net_sales']),
      units: Math.round(row['ItemSales.sales_quantity']),
    }))
    .sort((a, b) => b.net_sales - a.net_sales)
    .slice(0, 20);

  writeCsv(
    path.join(ROOT, 'puente_top_items.csv'),
    ['item_name', 'category', 'net_sales_usd', 'units_sold'],
    topItems.map((r) => [r.item, r.category, r.net_sales, r.units])
  );

  const categories = categoriesRaw
    .map((row) => ({
      category: row['ItemSales.category_name'] || 'Uncategorized',
      net_sales: round2(row['ItemSales.item_net_sales']),
    }))
    .sort((a, b) => b.net_sales - a.net_sales);
  const catTotal = categories.reduce((s, c) => s + c.net_sales, 0);

  writeCsv(
    path.join(ROOT, 'puente_category_mix.csv'),
    ['category', 'net_sales_usd', 'pct_of_item_sales'],
    categories.map((c) => [c.category, c.net_sales, round2((c.net_sales / catTotal) * 100)])
  );

  const hours = [...new Set(daypartSorted.map((r) => r.hour))].sort((a, b) => a - b);
  const gridMap = Object.fromEntries(DAY_ORDER.map((d) => [d, Object.fromEntries(hours.map((h) => [h, 0]))]));
  let maxDaypart = 0;
  for (const r of daypartSorted) {
    gridMap[r.day][r.hour] = r.net_sales;
    maxDaypart = Math.max(maxDaypart, r.net_sales);
  }

  const data = {
    lifetime: {
      net_sales: lifetime.net_sales,
      total_sales: lifetime.total_sales,
      order_count: lifetime.order_count,
      avg_order_value: lifetime.avg_order_value,
      unique_customers: lifetime.unique_customers,
    },
    locations: locations.map((l) => ({
      location: l.location,
      net_sales: l.net_sales,
      total_sales_amount: l.total_sales_amount,
      order_count: l.order_count,
      avg_order_value: l.avg_order_value,
      unique_customers: l.unique_customers,
      status: l.status,
      type: l.type,
    })),
    monthly: flagshipMonths,
    top_items: topItems.map((r) => ({
      item: r.item,
      category: r.category,
      net_sales: r.net_sales,
      units: r.units,
    })),
    categories: categories.map((c) => [c.category, c.net_sales]),
    daypart: {
      days: DAY_ORDER,
      hours,
      max: maxDaypart,
      grid: DAY_ORDER.map((day) => ({
        day,
        values: hours.map((h) => gridMap[day][h] || 0),
      })),
    },
  };

  const htmlPath = path.join(ROOT, 'index.html');
  let html = fs.readFileSync(htmlPath, 'utf8');
  html = html.replace(/const DATA = \{[\s\S]*?\};\n\nfunction css/, `const DATA = ${JSON.stringify(data)};\n\nfunction css`);
  html = html.replace(
    /Square sales data, Jan 2024 – [^·]+/,
    'Square sales data, Jan 2024 – Oct 2026 (partial) '
  );
  html = html.replace(
    /<strong>Reading note on the timeline below:<\/strong>[\s\S]*?through Sept 2025\./,
    `<strong>Reading note on the timeline below:</strong> Puente closed the flagship location for a change during
    Oct 2025 – May 2026 (near-zero sales in that window are the closure, not a demand drop). Trading resumed in
    June 2026 and has climbed every month since (June $3.1K → July $5.8K → Aug $6.9K → Sept $9.5K, full month → Oct $3.4K
    so far, ~5 days in) — September already back above the pre-closure Sept 2025 run rate. Pre-closure, the flagship
    location grew from a ~$1K opening month to a peak of ~$14.8K/month (Nov 2024) and sustained $6.4–11.2K/month
    through Sept 2025.`
  );
  html = html.replace(/pulled\s+\d{4}-\d{2}-\d{2}/, `pulled ${PULL_DATE}`);
  fs.writeFileSync(htmlPath, html);

  console.log(`Updated CSVs and index.html (Square pull through ${DATE_END}).`);
  console.log(`Lifetime net sales: $${lifetime.net_sales.toLocaleString()}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
