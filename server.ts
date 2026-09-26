import express from 'express';
import http from 'http';
import path from 'path';
import crypto from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer as createViteServer } from 'vite';
import nodemailer from 'nodemailer';
import { firestoreGetDocument, firestoreSaveDocument, firestoreGetDocumentOrFromDatabase } from './src/firebase';

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// Enable CORS for all incoming requests (crucial for Android WebView APK, Capacitor, Cordova, and Cross-Origin clients)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Master Admin Security Key (Only Admin Knows This Key)
let MASTER_ADMIN_AUTH_CODES = ['IB-AUTH-2026', 'ADMIN-IB-889', 'IB-PUSAT-99'];

// Storage for OTP Referral Codes (In-memory cache with SHA-256 hash & expiry)
interface ReferralRecord {
  email: string;
  phone?: string;
  username: string;
  otpHash: string;
  createdAtMs: number;
  expiresAtMs: number;
  used: boolean;
}
const referralCodesStore = new Map<string, ReferralRecord>();

// Storage for External PDF Downloads & Views (For APK & External Browser)
interface StoredDocument {
  id: string;
  type: 'nota' | 'slip';
  filename: string;
  title: string;
  htmlContent: string;
  base64Pdf?: string;
  phone?: string;
  waMessage?: string;
  createdAt: number;
}
const documentStore = new Map<string, StoredDocument>();

function formatRupiahServer(num: number | string): string {
  const n = Number(num) || 0;
  return n.toLocaleString('id-ID');
}

function formatBulanIndoServer(periode: string): string {
  if (!periode) return '';
  const months: Record<string, string> = {
    '01': 'Januari', '02': 'Februari', '03': 'Maret', '04': 'April',
    '05': 'Mei', '06': 'Juni', '07': 'Juli', '08': 'Agustus',
    '09': 'September', '10': 'Oktober', '11': 'November', '12': 'Desember'
  };
  const parts = periode.split('-');
  if (parts.length === 2 && months[parts[1]]) {
    return `${months[parts[1]]} ${parts[0]}`;
  }
  return periode;
}

function generateReceiptHTMLServer(trx: any): string {
  const items = trx.items || [];
  const logoUrl = '/assets/logo-istana-bubur.png';
  const fallbackLogo = 'https://lh3.googleusercontent.com/d/1raKw_On7XyxlT5Oqz45gAIDmb0eUinMc';

  let idStr = String(trx.id || '');
  if (!idStr.startsWith('TRX')) {
    idStr = 'TRX-' + idStr.replace(/^#/, '');
  }

  let tglStr = trx.tanggal || '';
  if (!tglStr) {
    const now = new Date(trx.createdAt || Date.now());
    tglStr = `${now.getDate()}/${now.getMonth() + 1}/${now.getFullYear()} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  }

  const kasirStr = trx.kasir || 'Admin';
  const pelangganStr = trx.namaPelanggan || trx.nama_pelanggan || 'Umum';

  const itemsRowsHtml = items.map((it: any) => `
    <tr style="border-bottom: 1px solid #e5e7eb; page-break-inside: avoid; break-inside: avoid;">
      <td style="padding: 8px 6px; font-weight: 600; color: #111827; text-align: left; vertical-align: middle; word-break: break-word;">${it.nama || 'Produk'}</td>
      <td style="padding: 8px 6px; text-align: center; color: #111827; font-weight: 500; vertical-align: middle; white-space: nowrap;">${it.qty || 1}</td>
      <td style="padding: 8px 6px; text-align: right; color: #111827; font-weight: 500; vertical-align: middle; white-space: nowrap;">Rp ${formatRupiahServer(it.harga || 0)}</td>
      <td style="padding: 8px 6px; text-align: right; font-weight: 700; color: #111827; vertical-align: middle; white-space: nowrap;">Rp ${formatRupiahServer((it.qty || 1) * (it.harga || 0))}</td>
    </tr>
  `).join('');

  let ongkirRowHtml = '';
  if (trx.ongkir && Number(trx.ongkir) > 0) {
    ongkirRowHtml = `
      <tr style="border-bottom: 1px solid #e5e7eb; page-break-inside: avoid; break-inside: avoid;">
        <td style="padding: 8px 6px; font-weight: 600; color: #111827; text-align: left; vertical-align: middle;">Ongkir</td>
        <td style="padding: 8px 6px; text-align: center; color: #111827; font-weight: 500; vertical-align: middle; white-space: nowrap;">1</td>
        <td style="padding: 8px 6px; text-align: right; color: #111827; font-weight: 500; vertical-align: middle; white-space: nowrap;">Rp ${formatRupiahServer(trx.ongkir)}</td>
        <td style="padding: 8px 6px; text-align: right; font-weight: 700; color: #111827; vertical-align: middle; white-space: nowrap;">Rp ${formatRupiahServer(trx.ongkir)}</td>
      </tr>`;
  }

  const totalVal = Number(trx.total || 0);
  const bayarVal = (trx.bayar !== undefined && trx.bayar !== null && trx.bayar !== '') ? Number(trx.bayar) : totalVal;
  const kembaliVal = (trx.kembalian !== undefined && trx.kembalian !== null && trx.kembalian !== '') ? Number(trx.kembalian) : (trx.kembali !== undefined ? Number(trx.kembali) : Math.max(0, bayarVal - totalVal));

  return `
    <div id="pdf-receipt-content" style="width: 760px; max-width: 100%; min-height: 980px; font-family: -apple-system, BlinkMacSystemFont, Arial, sans-serif; background: #ffffff; padding: 36px 42px 32px 42px; box-sizing: border-box; color: #111827; line-height: 1.4; border: 1px solid #e5e7eb; position: relative; margin: 0 auto; box-shadow: 0 4px 20px rgba(0,0,0,0.06); border-radius: 4px;">
      <div style="position: absolute; top: 480px; left: 50%; transform: translate(-50%, -50%); width: 420px; height: 420px; opacity: 0.06; pointer-events: none; z-index: 0; display: flex; align-items: center; justify-content: center;">
        <img src="${logoUrl}" onerror="this.src='${fallbackLogo}'" style="max-width: 100%; max-height: 100%; object-fit: contain;" alt="Watermark Istana Bubur">
      </div>
      <div style="position: relative; z-index: 1;">
        <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 10px;">
          <div style="width: 160px; height: 90px; display: flex; align-items: center;">
            <img src="${logoUrl}" onerror="this.src='${fallbackLogo}'" style="max-width: 155px; max-height: 85px; object-fit: contain;" alt="Logo Istana Bubur">
          </div>
          <div style="text-align: right;">
            <h1 style="font-family: Arial, Helvetica, sans-serif; font-size: 28px; font-weight: 900; color: #a11d20; letter-spacing: 0.5px; margin: 0 0 4px 0; text-transform: uppercase; line-height: 1.1;">ISTANA BUBUR</h1>
            <div style="font-size: 12px; color: #374151; margin-top: 2px; line-height: 1.4;">Jln. Ki Hajar Dewantoro 1 No.27 Kel. Gunung Kelua</div>
            <div style="font-size: 12px; color: #374151; line-height: 1.4;">Kecamatan Samarinda Ulu, Samarinda, Kalimantan Timur</div>
            <div style="display: flex; justify-content: flex-end; align-items: center; gap: 14px; margin-top: 8px; font-size: 11.5px; color: #374151; flex-wrap: wrap;">
              <span>WA: 0857-5408-7689</span>
              <span>IG: @istanabuburr_</span>
              <span>TikTok: @istanabubur</span>
            </div>
          </div>
        </div>
        <div style="border-bottom: 4px solid #a11d20; margin-top: 12px; margin-bottom: 22px;"></div>
        <div style="text-align: center; margin-bottom: 22px;">
          <h2 style="font-family: Arial, Helvetica, sans-serif; font-size: 22px; font-weight: 900; color: #a11d20; letter-spacing: 3px; margin: 0; text-transform: uppercase;">NOTA PENJUALAN</h2>
        </div>
        <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 20px; font-size: 13px; color: #111827;">
          <div style="display: flex; flex-direction: column; gap: 6px;">
            <div>No. Transaksi : <span style="font-weight: 700;">${idStr}</span></div>
            <div>Tanggal : <span>${tglStr}</span></div>
          </div>
          <div style="display: flex; flex-direction: column; gap: 6px; text-align: right;">
            <div>Kasir : <span style="font-weight: 700;">${kasirStr}</span></div>
            <div>Pelanggan : <span style="font-weight: 700;">${pelangganStr}</span></div>
          </div>
        </div>
        <table style="width: 100%; border-collapse: collapse; margin-bottom: 12px; font-size: 13px;">
          <thead>
            <tr style="border-top: 2.5px solid #000000; border-bottom: 2.5px solid #000000; font-size: 12px; font-weight: 800; color: #000000; text-transform: uppercase;">
              <th style="text-align: left; padding: 9px 8px;">NAMA PRODUK</th>
              <th style="text-align: center; padding: 9px 8px; width: 70px;">QTY</th>
              <th style="text-align: right; padding: 9px 8px; width: 130px;">HARGA</th>
              <th style="text-align: right; padding: 9px 8px; width: 140px;">SUBTOTAL</th>
            </tr>
          </thead>
          <tbody>
            ${itemsRowsHtml}
            ${ongkirRowHtml}
          </tbody>
        </table>
        <div style="border-bottom: 1.5px solid #111827; margin-bottom: 16px;"></div>
        <div style="display: flex; justify-content: flex-end; margin-bottom: 22px;">
          <div style="width: 320px; font-size: 13px;">
            <div style="display: flex; justify-content: space-between; padding: 4px 0; font-weight: 700;">
              <span>Total Belanja</span>
              <span>Rp ${formatRupiahServer(totalVal)}</span>
            </div>
            <div style="display: flex; justify-content: space-between; padding: 4px 0; color: #4b5563;">
              <span>Tunai / Bayar</span>
              <span>Rp ${formatRupiahServer(bayarVal)}</span>
            </div>
            <div style="border-top: 2.5px solid #000000; margin: 6px 0;"></div>
            <div style="display: flex; justify-content: space-between; padding: 4px 0; font-weight: 900; font-size: 16px; color: #a11d20;">
              <span>Kembalian</span>
              <span>Rp ${formatRupiahServer(kembaliVal)}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function generateSlipGajiHTMLServer(pay: any): string {
  const harian = Number(pay.gajiHarian) || 0;
  const hari = Number(pay.hariMasuk) || 0;
  const bonus = Number(pay.bonus) || 0;
  const potongan = Number(pay.potongan) || 0;
  const totalGaji = Number(pay.totalGaji) || ((harian * hari) + bonus - potongan);
  const pokok = (harian && hari) ? (harian * hari) : (totalGaji - bonus + potongan);

  const periodeDisplay = formatBulanIndoServer(pay.bulan || '');
  const now = new Date(pay.createdAt || Date.now());
  const tglCetak = `${now.getDate()}/${now.getMonth() + 1}/${now.getFullYear()}`;

  const nama = pay.nama || 'Karyawan';
  const jabatan = pay.jabatan || 'Dapur Bubur';
  const cabang = pay.cabang || 'Samarinda';
  const ketLibur = pay.keteranganLibur || '';

  const logoUrl = '/assets/logo-istana-bubur.png';
  const fallbackLogo = 'https://lh3.googleusercontent.com/d/1raKw_On7XyxlT5Oqz45gAIDmb0eUinMc';

  const ttdSvg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 460 250" style="max-height: 64px; max-width: 170px; height: 100%; width: 100%; display: block;" fill="none">
      <path d="M 182 32 C 187 23 194 21 200 25 C 204 20 211 20 215 26" stroke="#000000" stroke-width="3.8" stroke-linecap="round" stroke-linejoin="round" />
      <path d="M 28 126 C 12 108 26 78 78 62 C 135 46 198 62 216 88 C 228 106 210 134 162 148 C 112 162 38 158 18 138 C 8 126 14 110 48 92" stroke="#000000" stroke-width="3.8" stroke-linecap="round" stroke-linejoin="round" />
      <path d="M 160 34 C 148 78 114 162 90 218 C 82 234 88 242 100 238 C 114 232 132 208 148 168 C 168 118 180 68 172 38 C 168 32 160 30 156 36" stroke="#000000" stroke-width="3.8" stroke-linecap="round" stroke-linejoin="round" />
      <path d="M 68 68 C 105 64 155 65 198 68" stroke="#000000" stroke-width="3.5" stroke-linecap="round" />
      <path d="M 160 120 L 174 72 L 184 122 L 196 72 L 206 122 L 218 72 L 228 122" stroke="#000000" stroke-width="3.8" stroke-linecap="round" stroke-linejoin="round" />
      <path d="M 194 125 L 285 128" stroke="#000000" stroke-width="3.8" stroke-linecap="round" />
      <path d="M 228 122 C 235 90 248 55 258 48 C 265 52 260 75 250 115 C 232 178 212 232 205 244 C 200 250 205 255 212 250 C 225 240 250 190 272 130 C 290 82 304 48 296 46 C 288 46 280 68 276 102 C 274 120 282 125 298 120 C 320 112 355 118 395 118 C 415 118 435 117 448 118" stroke="#000000" stroke-width="3.8" stroke-linecap="round" stroke-linejoin="round" />
    </svg>`;

  return `
    <div class="slip-gaji-container" style="width: 535px; max-width: 100%; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; background: #ffffff; padding: 26px 30px 22px 30px; box-sizing: border-box; color: #111827; line-height: 1.4; border: 1px solid #d1d5db; position: relative; overflow: hidden; margin: 0 auto; box-shadow: 0 4px 16px rgba(0,0,0,0.06); border-radius: 4px;">
      <div style="position: absolute; top: 48%; left: 50%; transform: translate(-50%, -50%); width: 330px; height: 330px; opacity: 0.10; pointer-events: none; z-index: 0; display: flex; align-items: center; justify-content: center;">
        <img src="${logoUrl}" onerror="this.src='${fallbackLogo}'" style="max-width: 100%; max-height: 100%; object-fit: contain;" alt="Watermark Istana Bubur">
      </div>
      <div style="position: relative; z-index: 1;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
          <div style="width: 110px; height: 70px; display: flex; align-items: center;">
            <img src="${logoUrl}" onerror="this.src='${fallbackLogo}'" style="max-width: 105px; max-height: 68px; object-fit: contain;" alt="Logo Istana Bubur">
          </div>
          <div style="text-align: right; font-family: Arial, Helvetica, sans-serif;">
            <div style="font-size: 21px; font-weight: 900; color: #004b87; letter-spacing: 0.5px; text-transform: uppercase; line-height: 1.1;">ISTANA BUBUR</div>
            <div style="font-size: 9.5px; font-style: italic; color: #4b5563; margin-top: 3px; line-height: 1.25;">Jln. Ki Hajar Dewantoro 1 No.27 Kelurahan Gunung Kelua, Samarinda</div>
            <div style="font-size: 10px; font-weight: 700; color: #1f2937; margin-top: 3px;">Sistem Payroll &amp; Manajemen SDM Pusat</div>
          </div>
        </div>
        <div style="border-bottom: 1px solid #cbd5e1; margin-bottom: 14px;"></div>
        <div style="text-align: center; margin-bottom: 16px;">
          <div style="font-size: 15px; font-weight: 800; color: #000000; letter-spacing: 0.5px; text-transform: uppercase;">SLIP GAJI KARYAWAN</div>
          <div style="font-size: 11px; color: #374151; margin-top: 2px; font-weight: 500;">Periode: ${periodeDisplay || pay.bulan}</div>
        </div>
        <div style="display: flex; justify-content: space-between; align-items: flex-start; font-size: 11px; margin-bottom: 14px;">
          <table style="border-collapse: collapse; font-size: 11px; line-height: 1.5;">
            <tr>
              <td style="font-weight: 700; color: #000000; padding: 1px 12px 1px 0; white-space: nowrap;">Nama Karyawan:</td>
              <td style="color: #111827; padding: 1px 0;">${nama}</td>
            </tr>
            <tr>
              <td style="font-weight: 700; color: #000000; padding: 1px 12px 1px 0; white-space: nowrap;">Jabatan:</td>
              <td style="color: #111827; padding: 1px 0;">${jabatan}</td>
            </tr>
            <tr>
              <td style="font-weight: 700; color: #000000; padding: 1px 12px 1px 0; white-space: nowrap;">Cabang Kerja:</td>
              <td style="color: #111827; padding: 1px 0;">${cabang}</td>
            </tr>
          </table>
          <div style="font-size: 11px; white-space: nowrap; padding-top: 1px;">
            <span style="font-weight: 700; color: #000000;">Tanggal Cetak:</span>
            <span style="color: #111827; margin-left: 4px;">${tglCetak}</span>
          </div>
        </div>
        <table style="width: 100%; border-collapse: collapse; font-size: 11px; margin-bottom: 6px;">
          <thead>
            <tr style="border-top: 1.5px solid #000000; border-bottom: 1.5px solid #000000;">
              <th style="text-align: left; padding: 6px 0; font-weight: 700; color: #000000;">Keterangan</th>
              <th style="text-align: right; padding: 6px 0; font-weight: 700; color: #000000;">Jumlah</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td style="padding: 7px 0; color: #111827;">Gaji Pokok ${hari && harian ? `(Hari Kerja: ${hari} hr x Rp ${formatRupiahServer(harian)})` : (hari ? `(Hari Kerja: ${hari} hr)` : '')}</td>
              <td style="padding: 7px 0; text-align: right; font-weight: 600; color: #111827;">Rp ${formatRupiahServer(pokok)}</td>
            </tr>
            ${bonus > 0 ? `
            <tr>
              <td style="padding: 4px 0; color: #16a34a; font-weight: 500;">Bonus Kinerja &amp; Tunjangan</td>
              <td style="padding: 4px 0; text-align: right; font-weight: 600; color: #16a34a;">+ Rp ${formatRupiahServer(bonus)}</td>
            </tr>` : ''}
            <tr>
              <td style="padding: 4px 0; color: #dc2626; font-weight: 500;">Potongan Kasbon</td>
              <td style="padding: 4px 0; text-align: right; font-weight: 600; color: #dc2626;">- Rp ${formatRupiahServer(potongan)}</td>
            </tr>
          </tbody>
        </table>
        ${ketLibur ? `
        <div style="font-size: 10.5px; font-style: italic; color: #4b5563; margin-bottom: 10px; padding-top: 2px;">
          Informasi: ${ketLibur}
        </div>` : ''}
        <div style="border-top: 1px solid #e5e7eb; margin: 12px 0 10px 0;"></div>
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 2px 0;">
          <span style="font-size: 13px; font-weight: 800; color: #000000; letter-spacing: 0.5px;">TOTAL DITERIMA</span>
          <span style="font-size: 14px; font-weight: 800; color: #16a34a;">Rp ${formatRupiahServer(totalGaji)}</span>
        </div>
        <div style="border-bottom: 1.5px solid #000000; margin: 10px 0 18px 0;"></div>
        <div style="display: flex; justify-content: space-between; align-items: flex-end; margin-top: 14px;">
          <div style="text-align: center; width: 140px;">
            <div style="font-size: 10.5px; color: #374151; margin-bottom: 46px;">Penerima,</div>
            <div style="font-weight: 700; font-size: 11px; color: #000000; border-top: 1px solid #9ca3af; padding-top: 4px;">${nama}</div>
          </div>
          <div style="text-align: center; width: 170px;">
            <div style="font-size: 10.5px; color: #374151; margin-bottom: 4px;">Samarinda, Owner</div>
            <div style="display: flex; justify-content: center; align-items: center; height: 50px; margin-bottom: 2px;">
              ${ttdSvg}
            </div>
            <div style="font-weight: 800; font-size: 11px; color: #000000; border-top: 1px solid #9ca3af; padding-top: 4px;">JAMILAH</div>
            <div style="font-size: 9px; color: #6b7280;">Owner Istana Bubur</div>
          </div>
        </div>
      </div>
    </div>
  `;
}

// Helper untuk mengambil dokumen dari memory store atau Firestore cloud fallback
async function getStoredOrFirestoreDoc(docId: string): Promise<StoredDocument | null> {
  const cleanId = String(docId || '').replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!cleanId) return null;

  // 1. Cek memory store
  let doc = documentStore.get(cleanId);
  if (doc) return doc;

  // 2. Cek Cloud Firestore dengan fallback multi-sumber (documents, transactions, payroll)
  try {
    const res = await firestoreGetDocumentOrFromDatabase(cleanId);
    if (res) {
      if (res.source === 'documents' && res.data?.htmlContent) {
        const d = res.data;
        const storedObj: StoredDocument = {
          id: d.id || cleanId,
          type: d.type || 'nota',
          filename: d.filename || (d.type === 'slip' ? `Slip_Gaji_${cleanId}.pdf` : `Nota_${cleanId}.pdf`),
          title: d.title || (d.type === 'slip' ? 'Slip Gaji Karyawan' : 'Nota Penjualan'),
          htmlContent: d.htmlContent,
          base64Pdf: d.base64Pdf || undefined,
          phone: d.phone || '',
          waMessage: d.waMessage || '',
          createdAt: d.createdAt || Date.now()
        };
        documentStore.set(cleanId, storedObj);
        documentStore.set(storedObj.id, storedObj);
        return storedObj;
      } else if (res.source === 'transactions' && res.data) {
        const trx = res.data;
        const trxId = trx.id || cleanId;
        const html = generateReceiptHTMLServer(trx);
        const storedObj: StoredDocument = {
          id: cleanId,
          type: 'nota',
          filename: `Nota_${String(trxId).replace(/[^a-zA-Z0-9._-]/g, '_')}.pdf`,
          title: `Nota Penjualan #${trxId}`,
          htmlContent: html,
          phone: trx.noWa || '',
          waMessage: `Nota Penjualan #${trxId}`,
          createdAt: trx.createdAt || Date.now()
        };
        documentStore.set(cleanId, storedObj);
        documentStore.set(storedObj.id, storedObj);
        try { await firestoreSaveDocument(storedObj); } catch (_) {}
        return storedObj;
      } else if (res.source === 'payroll' && res.data) {
        const pay = res.data;
        const cleanName = String(pay.nama || 'Karyawan').replace(/\s+/g, '_');
        const cleanBulan = String(pay.bulan || '').replace(/[^a-zA-Z0-9]/g, '_');
        const html = generateSlipGajiHTMLServer(pay);
        const storedObj: StoredDocument = {
          id: cleanId,
          type: 'slip',
          filename: `Slip_Gaji_${cleanName}_${cleanBulan}.pdf`,
          title: `Slip Gaji - ${pay.nama || 'Karyawan'}`,
          htmlContent: html,
          phone: pay.noWa || '',
          waMessage: `Slip Gaji - ${pay.nama || 'Karyawan'}`,
          createdAt: pay.createdAt || Date.now()
        };
        documentStore.set(cleanId, storedObj);
        documentStore.set(storedObj.id, storedObj);
        try { await firestoreSaveDocument(storedObj); } catch (_) {}
        return storedObj;
      }
    }
  } catch (err) {
    console.warn('[server.ts getStoredOrFirestoreDoc warning]:', err);
  }

  return null;
}

// Periodic cleanup of documents older than 30 days (for persistent WhatsApp links)
setInterval(() => {
  const now = Date.now();
  for (const [id, doc] of documentStore.entries()) {
    if (now - doc.createdAt > 30 * 24 * 3600 * 1000) {
      documentStore.delete(id);
    }
  }
}, 60 * 60 * 1000);

// Email Transporter Helper with connection pool, dual port (465 SSL & 587 TLS), and deliverability headers
let sharedPooledTransporter: any = null;

function getSharedEmailTransporter() {
  const user = (process.env.SMTP_USER || 'istanabubur89@gmail.com').trim();
  const rawPass = process.env.SMTP_PASS || process.env.SMTP_PASSWORD || 'axqgkpswdfooekzu';
  const pass = rawPass ? rawPass.replace(/\s+/g, '') : '';
  const from = process.env.SMTP_FROM || `"Istana Bubur" <${user}>`;

  if (!user || !pass) {
    return { transporter: null, from, user, isLive: false };
  }

  if (!sharedPooledTransporter) {
    sharedPooledTransporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user, pass },
      pool: true,
      maxConnections: 3,
      maxMessages: 100,
      rateLimit: 5,
      rateDelta: 1000,
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
      tls: {
        rejectUnauthorized: false
      }
    });
  }

  return {
    transporter: sharedPooledTransporter,
    from,
    user,
    isLive: true
  };
}

function createEmailTransporter(forcePort?: number) {
  const host = process.env.SMTP_HOST || 'smtp.gmail.com';
  const defaultPort = parseInt(process.env.SMTP_PORT || '465', 10);
  const port = forcePort || defaultPort;
  const secure = port === 465;
  const user = (process.env.SMTP_USER || 'istanabubur89@gmail.com').trim();
  const rawPass = process.env.SMTP_PASS || process.env.SMTP_PASSWORD || 'axqgkpswdfooekzu';
  const pass = rawPass ? rawPass.replace(/\s+/g, '') : '';
  const from = process.env.SMTP_FROM || `"Istana Bubur" <${user}>`;

  if (user && pass) {
    return {
      transporter: nodemailer.createTransport({
        host,
        port,
        secure,
        auth: { user, pass },
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 15000,
        tls: {
          rejectUnauthorized: false
        }
      }),
      from,
      user,
      port,
      isLive: true
    };
  }

  return {
    transporter: nodemailer.createTransport({
      jsonTransport: true
    }),
    from,
    user,
    port,
    isLive: false
  };
}

async function sendEmailWithFallback({
  to,
  subject,
  html,
  text
}: {
  to: string;
  subject: string;
  html: string;
  text?: string;
}) {
  const cleanTo = String(to || '').trim().toLowerCase();
  if (!cleanTo) {
    return { success: false, isLive: false, error: 'Alamat email tujuan kosong' };
  }

  const plainText = text || html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                                .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                                .replace(/<[^>]+>/g, ' ')
                                .replace(/\s+/g, ' ')
                                .trim();

  // Opsi Pengiriman Email
  const mailOptions = {
    to: cleanTo,
    subject,
    text: plainText,
    html,
    priority: 'high' as const,
    headers: {
      'X-Priority': '1 (Highest)',
      'X-MSMail-Priority': 'High',
      'Importance': 'High',
      'X-Mailer': 'Istana-Bubur-Auth-System'
    }
  };

  // Percobaan 1: Gunakan Shared Pooled Transporter (service: gmail) - Cepat (<1.5 detik)
  const shared = getSharedEmailTransporter();
  if (shared.isLive && shared.transporter) {
    try {
      const info = await shared.transporter.sendMail({
        from: shared.from,
        replyTo: shared.user,
        ...mailOptions
      });
      console.log(`[SMTP POOL SUCCESS] Sent to ${cleanTo} | ID: ${info?.messageId}`);
      return { success: true, isLive: true, info, method: 'pool' };
    } catch (poolErr: any) {
      console.warn('[SMTP POOL GAGAL, MENCOBA PORT 465 LANGSUNG]:', poolErr?.message || poolErr);
      // Reset pool jika terjadi koneksi terputus
      try {
        sharedPooledTransporter?.close();
      } catch (e) {}
      sharedPooledTransporter = null;
    }
  }

  // Percobaan 2: Port 465 (Direct SSL)
  try {
    const primary = createEmailTransporter(465);
    if (!primary.isLive) {
      return { success: false, isLive: false, error: 'Kredensial SMTP belum disetel' };
    }
    const info = await primary.transporter.sendMail({
      from: primary.from,
      replyTo: primary.user,
      ...mailOptions
    });
    console.log(`[SMTP 465 SUCCESS] Sent to ${cleanTo} | ID: ${info?.messageId}`);
    return { success: true, isLive: true, info, port: 465, method: 'port465' };
  } catch (err465: any) {
    console.warn('[SMTP 465 GAGAL, MENCOBA PORT 587 TLS]:', err465?.message || err465);

    // Percobaan 3: Port 587 (TLS/STARTTLS)
    try {
      const fallback = createEmailTransporter(587);
      const info = await fallback.transporter.sendMail({
        from: fallback.from,
        replyTo: fallback.user,
        ...mailOptions
      });
      console.log(`[SMTP 587 SUCCESS] Sent to ${cleanTo} | ID: ${info?.messageId}`);
      return { success: true, isLive: true, info, port: 587, method: 'port587' };
    } catch (err587: any) {
      console.error('[SMTP 587 GAGAL JUGA]:', err587?.message || err587);
      return {
        success: false,
        isLive: true,
        error: err587?.message || err465?.message || 'Gagal mengirim email melalui SMTP Gmail'
      };
    }
  }
}


export interface ChatMessage {
  id: string;
  cabang: string;
  sender: string;
  role: 'Admin' | 'Kasir';
  text: string;
  timestamp: string;
  formattedTime: string;
}

export interface ClientConnection {
  ws: WebSocket;
  username: string;
  role: 'Admin' | 'Kasir';
  cabang: string;
}

// In-memory chat storage seeded with initial conversation (tanpa hardcode Cabang A, B, C)
const chatMessages: ChatMessage[] = [];

const clients = new Set<ClientConnection>();

function broadcast(payload: any, filterFn?: (client: ClientConnection) => boolean) {
  const jsonStr = JSON.stringify(payload);
  clients.forEach(client => {
    if (client.ws.readyState === WebSocket.OPEN) {
      if (!filterFn || filterFn(client)) {
        try {
          client.ws.send(jsonStr);
        } catch (e) {
          console.error('Error sending WS message:', e);
        }
      }
    }
  });
}

function getOnlineSummary() {
  const onlineList: Array<{ username: string; role: string; cabang: string }> = [];
  clients.forEach(c => {
    if (c.ws.readyState === WebSocket.OPEN && c.username) {
      onlineList.push({ username: c.username, role: c.role, cabang: c.cabang });
    }
  });
  return onlineList;
}

// REST API Endpoints
app.use('/assets', express.static(path.join(process.cwd(), 'public/assets')));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// Prepare document for external view & download outside Android APK
app.post('/api/pdf/prepare-doc', (req, res) => {
  try {
    const { type, filename, title, htmlContent, base64Pdf, phone, waMessage } = req.body;
    if (!htmlContent) {
      return res.status(400).json({ success: false, message: 'htmlContent wajib diisi' });
    }

    const customId = req.body.customId ? String(req.body.customId).replace(/[^a-zA-Z0-9._-]/g, '_') : '';
    const docId = customId || ('ib-' + Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex'));
    const safeFilename = (filename || (type === 'slip' ? 'Slip_Gaji.pdf' : 'Nota_Transaksi.pdf')).replace(/[^a-zA-Z0-9._-]/g, '_');
    const docObj: StoredDocument = {
      id: docId,
      type: type === 'slip' ? 'slip' : 'nota',
      filename: safeFilename.endsWith('.pdf') ? safeFilename : safeFilename + '.pdf',
      title: title || (type === 'slip' ? 'Slip Gaji Karyawan' : 'Nota Transaksi'),
      htmlContent,
      base64Pdf: base64Pdf || undefined,
      phone: phone || '',
      waMessage: waMessage || '',
      createdAt: Date.now()
    };

    documentStore.set(docId, docObj);

    // Simpan juga ke Firestore untuk redundansi data cloud
    firestoreSaveDocument(docObj).catch(err => {
      console.warn('[prepare-doc Firestore save warning]:', err);
    });

    res.json({
      success: true,
      docId,
      viewUrl: `/view-doc/${docId}`,
      downloadUrl: `/api/pdf/download/${docId}`
    });
  } catch(err: any) {
    console.error('Error prepare-doc:', err);
    res.status(500).json({ success: false, message: 'Gagal menyiapkan dokumen: ' + err.message });
  }
});

// ==========================================
// GOOGLE DRIVE SESSION & UPLOAD PROXY (ANDROID APK & WEB READY)
// ==========================================
const DEFAULT_GDRIVE_TARGET_FOLDER = '1-Q_CN5nca3vKCMNH9ljM0p3BMalHwcGw';
let globalGdriveSession: { token: string; email?: string; timestamp: number } | null = null;

// Get active Google Drive token (for syncing to Android WebView APK)
app.get('/api/gdrive/session', (req, res) => {
  if (globalGdriveSession && globalGdriveSession.token) {
    // Check if token is within reasonable lifespan (under 55 minutes)
    const ageMs = Date.now() - globalGdriveSession.timestamp;
    if (ageMs < 55 * 60 * 1000) {
      return res.json({
        connected: true,
        email: globalGdriveSession.email || 'Akun Google Terhubung',
        token: globalGdriveSession.token,
        defaultFolderId: DEFAULT_GDRIVE_TARGET_FOLDER
      });
    }
  }
  res.json({
    connected: false,
    token: null,
    defaultFolderId: DEFAULT_GDRIVE_TARGET_FOLDER
  });
});

// Sync active Google Drive token from client (Desktop/Mobile Web to Server & APK)
app.post('/api/gdrive/session', (req, res) => {
  const { token, email } = req.body;
  if (!token) {
    globalGdriveSession = null;
    return res.json({ success: true, message: 'Google Drive session cleared' });
  }
  globalGdriveSession = {
    token: String(token).trim(),
    email: email || '',
    timestamp: Date.now()
  };

  // Broadcast to all active WebSocket clients (e.g. Android WebView APKs)
  broadcast({
    type: 'GDRIVE_SYNC',
    email: globalGdriveSession.email,
    token: globalGdriveSession.token,
    defaultFolderId: DEFAULT_GDRIVE_TARGET_FOLDER
  });

  res.json({ success: true, message: 'Google Drive session synced successfully' });
});

// Server-side upload to Google Drive (Guaranteed to work for Android WebView APK)
app.post('/api/gdrive/upload', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    let token = '';
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7).trim();
    } else if (globalGdriveSession?.token) {
      token = globalGdriveSession.token;
    }

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Belum terhubung ke Google Drive. Silakan hubungkan akun Google Drive terlebih dahulu.'
      });
    }

    const { filename, base64Pdf, folderId } = req.body;
    if (!base64Pdf) {
      return res.status(400).json({ success: false, message: 'base64Pdf wajib disertakan' });
    }

    const targetFolder = (folderId && String(folderId).trim()) || DEFAULT_GDRIVE_TARGET_FOLDER;
    const cleanBase64 = String(base64Pdf).replace(/^data:application\/pdf;base64,/, '');
    const pdfBuffer = Buffer.from(cleanBase64, 'base64');
    const safeFilename = (filename || 'Dokumen_Istana_Bubur.pdf').replace(/[^a-zA-Z0-9._-]/g, '_');

    // Multipart upload request to Google Drive v3
    const metadata: any = {
      name: safeFilename,
      mimeType: 'application/pdf'
    };
    if (targetFolder) {
      metadata.parents = [targetFolder];
    }

    const boundary = '-------IstanaBuburUploadBoundary' + Date.now();
    const delimiter = `\r\n--${boundary}\r\n`;
    const closeDelimiter = `\r\n--${boundary}--`;

    const metadataPart = `${delimiter}Content-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}`;
    const fileHeaderPart = `\r\n--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`;

    const bodyBuffer = Buffer.concat([
      Buffer.from(metadataPart, 'utf-8'),
      Buffer.from(fileHeaderPart, 'utf-8'),
      pdfBuffer,
      Buffer.from(closeDelimiter, 'utf-8')
    ]);

    let uploadResp = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink,webContentLink', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
        'Content-Length': String(bodyBuffer.length)
      },
      body: bodyBuffer
    });

    // Fallback if target folder is permission restricted
    if (!uploadResp.ok && (uploadResp.status === 404 || uploadResp.status === 403) && targetFolder) {
      console.warn(`[server.ts gdrive upload] Folder ${targetFolder} rejected (${uploadResp.status}). Retrying to root...`);
      const fallbackMetadata = { name: safeFilename, mimeType: 'application/pdf' };
      const fallbackMetaPart = `${delimiter}Content-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(fallbackMetadata)}`;
      const fallbackBody = Buffer.concat([
        Buffer.from(fallbackMetaPart, 'utf-8'),
        Buffer.from(fileHeaderPart, 'utf-8'),
        pdfBuffer,
        Buffer.from(closeDelimiter, 'utf-8')
      ]);

      uploadResp = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink,webContentLink', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': `multipart/related; boundary=${boundary}`,
          'Content-Length': String(fallbackBody.length)
        },
        body: fallbackBody
      });
    }

    if (!uploadResp.ok) {
      const errText = await uploadResp.text();
      console.error('[server.ts gdrive upload error]:', uploadResp.status, errText);
      return res.status(uploadResp.status).json({
        success: false,
        message: `Gagal upload ke Google Drive (${uploadResp.status}): ${errText}`
      });
    }

    const driveFile: any = await uploadResp.json();
    const fileId = driveFile.id;

    // Set permission to anyone with link (reader)
    try {
      await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ role: 'reader', type: 'anyone' })
      });
    } catch(permErr) {
      console.warn('[server.ts gdrive permission warning]:', permErr);
    }

    const viewUrl = driveFile.webViewLink || `https://drive.google.com/file/d/${fileId}/view?usp=sharing`;
    const downloadUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;

    res.json({
      success: true,
      fileId,
      viewUrl,
      downloadUrl,
      webContentLink: downloadUrl,
      folderId: targetFolder
    });
  } catch(err: any) {
    console.error('[server.ts gdrive upload exception]:', err);
    res.status(500).json({ success: false, message: 'Server upload error: ' + err.message });
  }
});

// Direct PDF File Download endpoint (forces attachment download in Android external browser)
app.get('/api/pdf/download/:docId', async (req, res) => {
  const doc = await getStoredOrFirestoreDoc(req.params.docId);
  if (!doc) {
    return res.status(404).send(`
      <!DOCTYPE html>
      <html>
        <head><title>Dokumen Tidak Ditemukan</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>
        <body style="font-family:sans-serif; text-align:center; padding:40px 20px;">
          <h2 style="color:#dc2626;">Dokumen Tidak Ditemukan</h2>
          <p>Tautan ini mungkin sudah kedaluwarsa. Silakan cetak ulang dari aplikasi Istana Bubur.</p>
        </body>
      </html>
    `);
  }

  if (doc.base64Pdf) {
    const pdfBuffer = Buffer.from(doc.base64Pdf, 'base64');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${doc.filename}"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    return res.send(pdfBuffer);
  }

  // If base64 isn't generated yet, redirect to external viewer with auto-download
  return res.redirect(`/view-doc/${doc.id}?download=1`);
});

// External Document Viewer & Print/Download Page (Accessible outside APK in Google Chrome / Browser)
app.get('/view-doc/:docId', async (req, res) => {
  const doc = await getStoredOrFirestoreDoc(req.params.docId);
  if (!doc) {
    return res.status(404).send(`
      <!DOCTYPE html>
      <html>
        <head><title>Dokumen Tidak Ditemukan</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>
        <body style="font-family:sans-serif; text-align:center; padding:40px 20px;">
          <h2 style="color:#dc2626;">Dokumen Tidak Ditemukan</h2>
          <p>Dokumen tidak tersedia atau sudah kedaluwarsa. Buka kembali aplikasi Istana Bubur untuk mencetak ulang.</p>
        </body>
      </html>
    `);
  }

  const hasBase64 = !!doc.base64Pdf;
  const isNota = doc.type === 'nota';
  const cleanPhone = (doc.phone || '').replace(/[^0-9]/g, '');
  const waTarget = cleanPhone.startsWith('0') ? '62' + cleanPhone.slice(1) : cleanPhone;
  const waUrl = waTarget 
    ? `whatsapp://send?phone=${waTarget}&text=${encodeURIComponent(doc.waMessage || '')}`
    : `whatsapp://send?text=${encodeURIComponent(doc.waMessage || '')}`;

  res.send(`
<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>${doc.title} - Istana Bubur</title>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  <script src="https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js"></script>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 0;
      background-color: #f1f5f9;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      color: #1e293b;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }
    .top-bar {
      position: sticky;
      top: 0;
      z-index: 50;
      background: #ffffff;
      border-bottom: 1px solid #e2e8f0;
      padding: 12px 16px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.06);
    }
    .top-bar-inner {
      max-width: 840px;
      margin: 0 auto;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }
    .brand-title {
      font-weight: 800;
      font-size: 15px;
      color: #dc2626;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .action-group {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 8px 14px;
      border-radius: 8px;
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
      text-decoration: none;
      border: none;
      transition: all 0.2s;
    }
    .btn-primary {
      background: #dc2626;
      color: #ffffff;
      box-shadow: 0 2px 4px rgba(220, 38, 38, 0.2);
    }
    .btn-primary:hover { background: #b91c1c; }
    .btn-secondary {
      background: #0f172a;
      color: #ffffff;
    }
    .btn-secondary:hover { background: #1e293b; }
    .btn-wa {
      background: #16a34a;
      color: #ffffff;
    }
    .btn-wa:hover { background: #15803d; }
    .content-wrap {
      flex: 1;
      display: flex;
      justify-content: center;
      align-items: flex-start;
      padding: 24px 12px 48px 12px;
    }
    .doc-card {
      background: #ffffff;
      border-radius: 12px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.08);
      border: 1px solid #e2e8f0;
      overflow: hidden;
      max-width: 100%;
    }
    @media print {
      body { background: #ffffff; }
      .top-bar { display: none !important; }
      .content-wrap { padding: 0 !important; }
      .doc-card { box-shadow: none !important; border: none !important; margin: 0 !important; }
      tr { page-break-inside: avoid !important; break-inside: avoid !important; }
    }
  </style>
</head>
<body>

  <header class="top-bar">
    <div class="top-bar-inner">
      <div class="brand-title">
        <i class="fas fa-file-invoice"></i>
        <span>Istana Bubur PDF</span>
      </div>
      <div class="action-group">
        <button id="btn-unduh" class="btn btn-primary" onclick="triggerDownload()">
          <i class="fas fa-download"></i> Unduh PDF
        </button>
        <button class="btn btn-secondary" onclick="window.print()">
          <i class="fas fa-print"></i> Cetak / Simpan
        </button>
        ${doc.phone ? `
        <a href="${waUrl}" class="btn btn-wa">
          <i class="fab fa-whatsapp"></i> Kirim WA
        </a>` : ''}
      </div>
    </div>
  </header>

  <main class="content-wrap">
    <div id="doc-render-area" class="doc-card">
      ${doc.htmlContent}
    </div>
  </main>

  <script>
    const hasBase64 = ${hasBase64};
    const downloadEndpoint = '/api/pdf/download/${doc.id}';
    const isNota = ${isNota};

    function triggerDownload() {
      const btn = document.getElementById('btn-unduh');
      if (btn) btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Mengunduh...';

      if (hasBase64) {
        // Direct stream download through browser download manager
        const a = document.createElement('a');
        a.href = downloadEndpoint;
        a.download = '${doc.filename}';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          a.remove();
          if (btn) btn.innerHTML = '<i class="fas fa-check"></i> Selesai!';
          setTimeout(() => {
            if (btn) btn.innerHTML = '<i class="fas fa-download"></i> Unduh PDF';
          }, 2000);
        }, 1000);
        return;
      }

      // Generate client side with html2pdf if base64 was not passed
      const el = document.getElementById('doc-render-area');
      const opt = {
        margin: [6, 6, 6, 6],
        filename: '${doc.filename}',
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: { scale: 2, useCORS: true },
        jsPDF: { unit: 'mm', format: isNota ? 'a4' : 'a5', orientation: 'portrait' },
        pagebreak: { mode: ['avoid-all', 'css', 'legacy'] }
      };

      html2pdf().set(opt).from(el).save().then(() => {
        if (btn) btn.innerHTML = '<i class="fas fa-check"></i> Berhasil Diunduh!';
        setTimeout(() => {
          if (btn) btn.innerHTML = '<i class="fas fa-download"></i> Unduh PDF';
        }, 2500);
      }).catch(err => {
        console.warn('html2pdf download error:', err);
        window.print();
      });
    }

    // Auto download when opened outside if query param ?download=1 is present
    if (window.location.search.includes('download=1') || window.location.search.includes('auto=1')) {
      window.addEventListener('DOMContentLoaded', () => {
        setTimeout(triggerDownload, 500);
      });
    }
  </script>
</body>
</html>
  `);
});

// Handle root URL with query parameter ?doc=nota-xxx or ?doc=slip-xxx
app.get('/', (req, res, next) => {
  const docId = req.query.doc as string;
  if (docId) {
    const isDownload = req.query.download === '1' || req.query.download === 'true';
    if (isDownload) {
      return res.redirect(`/api/pdf/download/${encodeURIComponent(docId)}`);
    } else {
      return res.redirect(`/view-doc/${encodeURIComponent(docId)}`);
    }
  }
  next();
});

app.get('/api/chat/messages', (req, res) => {
  const { cabang, role } = req.query;
  // If role is Admin, always return all messages so Admin can monitor and switch all branches
  if (role === 'Admin') {
    return res.json({ success: true, messages: chatMessages });
  }
  if (cabang && cabang !== 'Semua') {
    const filtered = chatMessages.filter(m => m.cabang === cabang || m.cabang === 'Semua');
    return res.json({ success: true, messages: filtered });
  }
  return res.json({ success: true, messages: chatMessages });
});

app.post('/api/chat/send', (req, res) => {
  const { cabang, sender, role, text } = req.body;
  if (!text || !sender) {
    return res.status(400).json({ success: false, message: 'Text dan sender harus diisi' });
  }

  const now = new Date();
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');

  const newMsg: ChatMessage = {
    id: req.body.id || ('msg-' + Date.now() + '-' + Math.floor(Math.random() * 1000)),
    cabang: cabang || 'Pusat',
    sender: sender,
    role: role || 'Kasir',
    text: String(text).trim(),
    timestamp: req.body.timestamp || now.toISOString(),
    formattedTime: req.body.formattedTime || `${hours}:${minutes}`
  };

  const existingIdx = chatMessages.findIndex(m => m.id === newMsg.id);
  if (existingIdx === -1) {
    chatMessages.push(newMsg);
  } else {
    chatMessages[existingIdx] = newMsg;
  }

  // Broadcast via WS
  broadcast({
    type: 'new_message',
    message: newMsg
  }, (client) => {
    // Admin receives all messages
    if (client.role === 'Admin') return true;
    // Kasir receives messages if matching branch or broadcast "Semua"
    return newMsg.cabang === 'Semua' || client.cabang === newMsg.cabang;
  });

  return res.json({ success: true, message: newMsg });
});

app.get('/api/chat/cabangs', (req, res) => {
  const cabangMap: Record<string, { lastMessage: ChatMessage | null; unreadCount: number }> = {};
  
  chatMessages.forEach(m => {
    if (m.cabang && !['Cabang A', 'Cabang B', 'Cabang C'].includes(m.cabang)) {
      if (!cabangMap[m.cabang]) {
        cabangMap[m.cabang] = { lastMessage: null, unreadCount: 0 };
      }
      cabangMap[m.cabang].lastMessage = m;
    }
  });

  res.json({
    success: true,
    cabangs: Object.keys(cabangMap).map(cabang => ({
      cabang,
      lastMessage: cabangMap[cabang].lastMessage
    }))
  });
});

app.post('/api/chat/clear-user', (req, res) => {
  const username = String(req.body.username || '').toLowerCase().trim();
  if (username) {
    for (let i = chatMessages.length - 1; i >= 0; i--) {
      if (chatMessages[i].sender.toLowerCase().trim() === username) {
        chatMessages.splice(i, 1);
      }
    }
  }
  broadcast({
    type: 'init',
    messages: chatMessages,
    onlineUsers: getOnlineSummary()
  });
  return res.json({ success: true, message: 'Riwayat percakapan user berhasil dihapus dari server.' });
});

app.post('/api/chat/clear-all', (req, res) => {
  chatMessages.length = 0;
  broadcast({
    type: 'init',
    messages: [],
    onlineUsers: getOnlineSummary()
  });
  return res.json({ success: true, message: 'Seluruh riwayat chat di server berhasil dibersihkan.' });
});

// ==========================================
// REAL EMAIL SENDER & ADMIN AUTH CODE API
// ==========================================

// Endpoint: Kirim Kode Referral (Sesuai spesifikasi Cloud Function & REST API)
app.post('/api/auth/send-referral-code', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const username = String(req.body.username || 'Pengguna').trim();
  const phone = String(req.body.phone || '').trim();
  const deliveryMethod = String(req.body.deliveryMethod || 'both').trim(); // 'both' | 'whatsapp' | 'email'

  // 1. Validasi format email
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!email || !emailRegex.test(email)) {
    return res.status(400).json({
      success: false,
      message: 'Format email tidak valid. Harap masukkan email yang benar (contoh: user@gmail.com).'
    });
  }

  // 2. Generate 6-digit OTP acak berbeda setiap kali
  const otp = String(crypto.randomInt(100000, 1000000));
  const otpHash = crypto.createHash('sha256').update(otp).digest('hex');
  const now = Date.now();
  const expiresAtMs = now + (10 * 60 * 1000); // 10 menit

  // Normalisasi nomor WhatsApp (Format 62...)
  let cleanPhone = phone.replace(/[^0-9]/g, '');
  if (cleanPhone.startsWith('0')) {
    cleanPhone = '62' + cleanPhone.slice(1);
  } else if (cleanPhone.startsWith('8')) {
    cleanPhone = '62' + cleanPhone;
  }

  // 3. Simpan hash & metadata (tersedia via email maupun nomor whatsapp)
  const record: ReferralRecord = {
    email,
    phone: cleanPhone || phone,
    username,
    otpHash,
    createdAtMs: now,
    expiresAtMs,
    used: false
  };
  referralCodesStore.set(email, record);
  if (cleanPhone) {
    referralCodesStore.set(cleanPhone, record);
  }

  // Sinkronisasikan juga ke universalOtpStore agar kedua endpoint verifikasi selalu valid
  universalOtpStore.set(`register_${email}`, {
    email,
    username,
    type: 'register',
    otpHash,
    createdAtMs: now,
    expiresAtMs,
    used: false
  });

  // 4. Siapkan format pesan WhatsApp resmi
  const waMsg = `*ISTANA BUBUR - KODE OTP PENDAFTARAN*\n\nHalo *${username}*,\nBerikut adalah 6-digit Kode OTP Verifikasi Pendaftaran Akun Anda:\n\n👉 *${otp}* 👈\n\nKode ini bersifat rahasia dan berlaku selama 10 menit.\nMasukkan kode ini pada aplikasi untuk menyelesaikan pendaftaran.`;
  const waUrl = cleanPhone 
    ? `https://api.whatsapp.com/send?phone=${cleanPhone}&text=${encodeURIComponent(waMsg)}`
    : `https://api.whatsapp.com/send?text=${encodeURIComponent(waMsg)}`;

  // 5. Siapkan Konten Email (Plain Text & HTML dengan Anti-Spam Best Practices)
  const subject = `[Istana Bubur] Kode OTP Verifikasi Pendaftaran: ${otp}`;
  const textContent = `ISTANA BUBUR - VERIFIKASI PENDAFTARAN AKUN

Halo ${username},

Berikut adalah 6-digit Kode OTP verifikasi pendaftaran akun baru Anda:

👉 ${otp} 👈

Kode OTP ini bersifat rahasia dan berlaku selama 10 menit.
Masukkan kode ini pada aplikasi Istana Bubur untuk menyelesaikan pendaftaran akun Anda.

💡 Tips: Jika Anda tidak menemukan email ini di Kotak Masuk (Inbox) utama Anda, periksa folder Spam atau Promosi.

--
Layanan Keamanan & Akun Istana Bubur
istanabubur89@gmail.com`;

  const htmlContent = `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Kode OTP Verifikasi Istana Bubur</title>
  </head>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; padding: 24px 12px; margin: 0;">
    <div style="display:none;font-size:1px;color:#f8fafc;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;">
      Kode OTP pendaftaran Istana Bubur Anda adalah ${otp}. Masukkan kode ini untuk mengaktifkan akun.
    </div>
    <div style="max-width: 500px; margin: 0 auto; background: #ffffff; border-radius: 16px; overflow: hidden; border: 1px solid #e2e8f0; box-shadow: 0 4px 16px rgba(0,0,0,0.06);">
      <div style="background: #dc2626; color: #ffffff; padding: 26px 20px; text-align: center;">
        <h1 style="margin: 0; font-size: 22px; font-weight: 900; letter-spacing: 1px; color: #ffffff;">🥣 ISTANA BUBUR</h1>
        <p style="margin: 6px 0 0; font-size: 13px; color: #fee2e2; font-weight: 600;">Verifikasi Pendaftaran Akun Baru</p>
      </div>
      <div style="padding: 26px 22px; color: #1e293b;">
        <p style="margin-top: 0; font-size: 15px; color: #334155;">Halo <strong>${username}</strong>,</p>
        <p style="font-size: 14px; color: #475569; line-height: 1.6;">
          Terima kasih telah mendaftar di sistem operasional <strong>Istana Bubur</strong>. Berikut adalah 6-digit kode OTP verifikasi pendaftaran akun Anda:
        </p>
        <div style="text-align: center; margin: 26px 0; background: #f8fafc; border: 1px dashed #cbd5e1; border-radius: 14px; padding: 20px;">
          <span style="display: inline-block; background: #0f172a; color: #38bdf8; font-family: 'Courier New', Courier, monospace; font-size: 36px; font-weight: 900; letter-spacing: 10px; padding: 14px 28px; border-radius: 12px; box-shadow: 0 2px 8px rgba(15,23,42,0.15);">
            ${otp}
          </span>
          <p style="color: #dc2626; font-size: 12px; font-weight: 700; margin: 12px 0 0;">⏳ Berlaku selama 10 Menit</p>
        </div>
        <div style="background: #fffbeb; border-left: 4px solid #f59e0b; padding: 12px 14px; border-radius: 6px; margin: 20px 0;">
          <p style="margin: 0; font-size: 12px; color: #92400e; line-height: 1.5;">
            <strong>💡 Tips Penting:</strong> Jika email ini masuk ke folder <strong>Spam</strong> atau <strong>Promosi</strong>, klik <strong>"Laporkan Bukan Spam"</strong> agar pemberitahuan berikutnya masuk ke Kotak Masuk utama Anda.
          </p>
        </div>
        <p style="font-size: 13px; color: #64748b; line-height: 1.5; margin-bottom: 0;">
          Jangan berikan kode ini kepada siapapun demi keamanan sistem. Masukkan kode ini pada aplikasi untuk menyelesaikan pendaftaran.
        </p>
      </div>
      <div style="background: #f8fafc; border-top: 1px solid #f1f5f9; padding: 16px; text-align: center; font-size: 11px; color: #94a3b8;">
        Email otomatis dari Sistem Keamanan & Akun Istana Bubur &bull; istanabubur89@gmail.com
      </div>
    </div>
  </body>
  </html>
  `;

  // 6. Kirim via SMTP jika metode melibatkan email
  let emailDelivered = false;
  let emailErrorMsg = '';

  if (deliveryMethod !== 'whatsapp') {
    try {
      const sendResult = await sendEmailWithFallback({
        to: email,
        subject,
        text: textContent,
        html: htmlContent
      });

      if (sendResult.success) {
        emailDelivered = true;
        console.log(`[SMTP SUCCESS] Sent to ${email} via ${sendResult.method || 'pool'}`);
      } else {
        emailErrorMsg = sendResult.error || 'Kendala koneksi SMTP';
        console.warn(`[SMTP WARN] Email to ${email} error: ${emailErrorMsg}`);
      }
    } catch (err: any) {
      emailErrorMsg = err?.message || 'Gagal mengirim email';
      console.warn(`[SMTP EXCEPTION] Email to ${email}:`, emailErrorMsg);
    }
  }

  // Response
  return res.json({
    success: true,
    emailDelivered,
    emailError: emailDelivered ? null : emailErrorMsg,
    phone: cleanPhone || phone,
    email,
    expiresAt: expiresAtMs,
    otpCode: otp,
    whatsappUrl: waUrl,
    whatsappMessage: waMsg,
    message: emailDelivered
      ? `Kode OTP verifikasi berhasil dikirim ke email ${email}. Silakan cek Kotak Masuk atau folder Spam email Anda.`
      : (cleanPhone
          ? `Kode OTP verifikasi siap dikirimkan ke WhatsApp ${phone}. Silakan buka chat WhatsApp untuk menerimanya.`
          : `Kode OTP verifikasi telah diproses untuk akun Anda. Silakan cek email atau gunakan nomor WhatsApp.`)
  });
});

// Endpoint status SMTP Gmail
app.get('/api/auth/smtp-status', async (req, res) => {
  const user = (process.env.SMTP_USER || 'istanabubur89@gmail.com').trim();
  const rawPass = process.env.SMTP_PASS || process.env.SMTP_PASSWORD || 'axqgkpswdfooekzu';
  const pass = rawPass ? rawPass.replace(/\s+/g, '') : '';

  if (!user || !pass) {
    return res.json({
      configured: false,
      message: 'SMTP belum dikonfigurasi'
    });
  }

  try {
    const t465 = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user, pass },
      connectionTimeout: 5000
    });
    await t465.verify();
    return res.json({
      configured: true,
      active: true,
      port: 465,
      user,
      message: 'SMTP Gmail resmi aktif dan terverifikasi'
    });
  } catch (e: any) {
    return res.json({
      configured: true,
      active: false,
      user,
      error: e.message
    });
  }
});

// Endpoint kompatibilitas: send-referral-email
app.post('/api/auth/send-referral-email', async (req, res) => {
  const { email, username, code, type } = req.body;
  if (!email || !code) {
    return res.status(400).json({ success: false, message: 'Alamat email dan kode verifikasi wajib diisi' });
  }

  const isReset = type === 'reset_password';
  const subject = isReset
    ? `[Istana Bubur] Kode OTP Reset Password Akun: ${code}`
    : `[Istana Bubur] Kode Referral Verifikasi Pendaftaran: ${code}`;

  const htmlContent = `
  <!DOCTYPE html>
  <html>
  <head><meta charset="utf-8"></head>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f8fafc; padding: 24px; margin: 0;">
    <div style="max-width: 500px; margin: 0 auto; background: #ffffff; border-radius: 16px; overflow: hidden; border: 1px solid #e2e8f0;">
      <div style="background: #dc2626; color: #ffffff; padding: 24px; text-align: center;">
        <h2 style="margin: 0; font-size: 22px; font-weight: 900; letter-spacing: 1px;">🥣 ISTANA BUBUR</h2>
        <p style="margin: 4px 0 0; font-size: 13px; color: #fee2e2;">${isReset ? 'Reset Password' : 'Verifikasi Pendaftaran'}</p>
      </div>
      <div style="padding: 24px; color: #1e293b;">
        <p>Halo <strong>${username || 'Pengguna'}</strong>,</p>
        <p>Kode verifikasi Anda adalah:</p>
        <div style="text-align: center; margin: 24px 0;">
          <div style="display: inline-block; background: #0f172a; color: #ffffff; font-family: monospace; font-size: 34px; font-weight: 900; letter-spacing: 8px; padding: 16px 32px; border-radius: 12px;">
            ${code}
          </div>
          <p style="color: #dc2626; font-size: 12px; font-weight: 700; margin-top: 10px;">⏳ Berlaku selama 10 Menit</p>
        </div>
      </div>
    </div>
  </body>
  </html>
  `;

  try {
    const sendResult = await sendEmailWithFallback({
      to: email,
      subject,
      html: htmlContent
    });

    if (sendResult.success) {
      return res.json({
        success: true,
        delivered: true,
        message: `Kode referral verifikasi telah dikirimkan ke email ${email}. Silakan periksa Kotak Masuk atau folder Spam Anda.`
      });
    }

    return res.json({
      success: true,
      delivered: false,
      message: `Email sedang diproses. Silakan periksa inbox/spam atau gunakan nomor WhatsApp yang didaftarkan.`
    });
  } catch (err: any) {
    return res.status(200).json({
      success: true,
      delivered: false,
      message: `Email sedang diproses. Silakan periksa inbox/spam atau gunakan nomor WhatsApp yang didaftarkan.`
    });
  }
});

// Endpoint: Verifikasi Kode Referral OTP
app.post('/api/auth/verify-referral-code', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const phone = String(req.body.phone || '').trim();
  const code = String(req.body.code || '').trim();

  if (!code || code.length !== 6) {
    return res.status(400).json({
      success: false,
      message: 'Kode OTP 6-digit wajib diisi.'
    });
  }

  let cleanPhone = phone.replace(/[^0-9]/g, '');
  if (cleanPhone.startsWith('0')) cleanPhone = '62' + cleanPhone.slice(1);
  else if (cleanPhone.startsWith('8')) cleanPhone = '62' + cleanPhone;

  let record = referralCodesStore.get(email);
  if (!record && cleanPhone) {
    record = referralCodesStore.get(cleanPhone);
  }

  // Fallback ke universalOtpStore jika diminta melalui endpoint alternatif
  if (!record) {
    const uni = universalOtpStore.get(`register_${email}`);
    if (uni) {
      record = {
        email: uni.email,
        phone: cleanPhone || phone,
        username: uni.username,
        otpHash: uni.otpHash,
        createdAtMs: uni.createdAtMs,
        expiresAtMs: uni.expiresAtMs,
        used: uni.used
      };
    }
  }

  if (!record) {
    return res.status(404).json({
      success: false,
      message: 'Kode OTP untuk data pendaftaran ini tidak ditemukan atau telah kedaluwarsa. Silakan minta kode baru.'
    });
  }

  if (record.used) {
    return res.status(400).json({
      success: false,
      message: 'Kode OTP ini sudah pernah digunakan. Silakan minta kode baru.'
    });
  }

  if (Date.now() > record.expiresAtMs) {
    return res.status(410).json({
      success: false,
      message: 'Kode OTP telah kedaluwarsa (lebih dari 10 menit). Silakan minta kode baru.'
    });
  }

  const inputHash = crypto.createHash('sha256').update(code).digest('hex');
  if (inputHash !== record.otpHash) {
    return res.status(401).json({
      success: false,
      message: 'Kode OTP tidak cocok! Periksa kembali angka yang diterima di Email atau WhatsApp Anda.'
    });
  }

  // Tandai kode sudah dipakai
  record.used = true;
  return res.json({
    success: true,
    message: 'Kode OTP verifikasi pendaftaran berhasil diverifikasi!'
  });
});

// Endpoint: Verifikasi Kode Autentikasi Khusus Admin
app.post('/api/auth/verify-admin-code', (req, res) => {
  const { code } = req.body;
  if (!code) {
    return res.status(400).json({ success: false, message: 'Kode autentikasi wajib diisi' });
  }

  const cleanCode = String(code).trim().toUpperCase();
  const isValid = MASTER_ADMIN_AUTH_CODES.map(c => c.toUpperCase()).includes(cleanCode);

  if (isValid) {
    return res.json({ success: true, message: 'Kode autentikasi valid dan terotorisasi oleh Admin Pusat.' });
  } else {
    return res.status(403).json({
      success: false,
      message: 'Kode autentikasi salah atau tidak valid! Hanya Admin/Owner Pusat yang mengetahui kode ini.'
    });
  }
});

// Endpoint: Dapatkan Kode Autentikasi Admin (Khusus Admin Login)
app.all('/api/auth/get-admin-codes', (req, res) => {
  const role = req.body?.role || req.query?.role || 'Admin';
  return res.json({
    success: true,
    activeCodes: MASTER_ADMIN_AUTH_CODES,
    primaryCode: MASTER_ADMIN_AUTH_CODES[0],
    codes: {
      Admin: MASTER_ADMIN_AUTH_CODES[0]
    }
  });
});

// Endpoint: Perbarui Kode Autentikasi Admin oleh Admin Pusat
app.post('/api/auth/update-admin-code', (req, res) => {
  const { role, newCode } = req.body;
  if (role !== 'Admin') {
    return res.status(403).json({ success: false, message: 'Hanya Admin yang berwenang mengubah kode autentikasi.' });
  }
  if (!newCode || String(newCode).trim().length < 4) {
    return res.status(400).json({ success: false, message: 'Kode autentikasi baru minimal 4 karakter.' });
  }

  const cleanNewCode = String(newCode).trim().toUpperCase();
  if (!MASTER_ADMIN_AUTH_CODES.includes(cleanNewCode)) {
    MASTER_ADMIN_AUTH_CODES = [cleanNewCode, ...MASTER_ADMIN_AUTH_CODES.filter(c => c !== cleanNewCode)];
  }

  return res.json({
    success: true,
    message: 'Kode Autentikasi Admin berhasil diperbarui!',
    activeCodes: MASTER_ADMIN_AUTH_CODES,
    primaryCode: MASTER_ADMIN_AUTH_CODES[0]
  });
});

// Endpoint: Simpan / Daftarkan User Baru ke Cloud Database Firebase Firestore
app.post('/api/auth/register-user', async (req, res) => {
  try {
    const userData = req.body;
    if (!userData || !userData.username || !userData.password) {
      return res.status(400).json({ success: false, message: 'Data pendaftaran tidak lengkap.' });
    }
    const uname = String(userData.username).trim().toLowerCase();
    const newId = userData.id || ('USR-' + Math.floor(100 + Math.random() * 900));
    const record = {
      id: newId,
      fullName: userData.fullName || userData.username,
      username: userData.username,
      password: userData.password,
      email: userData.email || '',
      phone: userData.phone || '',
      role: userData.role || 'Kasir',
      cabang: userData.cabang || 'Cabang Utama',
      isActive: userData.isActive !== false,
      authCode: userData.authCode || '',
      createdAt: new Date().toISOString()
    };

    const { db, COLLECTIONS } = await import('./src/firebase.ts');
    const { doc, setDoc, getDoc } = await import('firebase/firestore');

    const existing = await getDoc(doc(db, COLLECTIONS.USERS, uname));
    if (existing.exists()) {
      return res.status(400).json({ success: false, message: 'Username sudah terdaftar di Firestore. Silakan gunakan username lain.' });
    }

    await setDoc(doc(db, COLLECTIONS.USERS, uname), record);
    console.log(`[Firebase Firestore] User baru berhasil didaftarkan ke koleksi users: ${uname}`);
    return res.json({
      success: true,
      message: 'Akun berhasil disimpan ke Cloud Firestore!',
      user: record
    });
  } catch (err: any) {
    console.error('Error in /api/auth/register-user:', err);
    return res.status(500).json({ success: false, message: err?.message || 'Gagal menyimpan akun ke Cloud Firestore.' });
  }
});

// In-memory store untuk OTP serbaguna (register, forgot_username, forgot_password)
interface GenericOtpRecord {
  email: string;
  username?: string;
  type: 'register' | 'forgot_username' | 'forgot_password';
  otpHash: string;
  createdAtMs: number;
  expiresAtMs: number;
  used: boolean;
  userData?: any;
}
const universalOtpStore = new Map<string, GenericOtpRecord>();

// Endpoint: Kirim Kode OTP Serbaguna (Pendaftaran, Lupa Username, Lupa Password)
app.post('/api/auth/send-otp-email', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const type = String(req.body.type || 'register') as 'register' | 'forgot_username' | 'forgot_password';
  const username = String(req.body.username || '').trim();

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!email || !emailRegex.test(email)) {
    return res.status(400).json({
      success: false,
      message: 'Format email tidak valid! Harap gunakan email aktif (contoh: user@gmail.com).'
    });
  }

  let matchedUser: any = null;

  try {
    const { db, COLLECTIONS } = await import('./src/firebase.ts');
    const { doc, getDoc, getDocs, collection } = await import('firebase/firestore');

    if (type === 'forgot_username') {
      const snap = await getDocs(collection(db, COLLECTIONS.USERS));
      for (const d of snap.docs) {
        const u = d.data();
        if (u.email && u.email.trim().toLowerCase() === email) {
          matchedUser = { id: d.id, ...u };
          break;
        }
      }
      if (!matchedUser) {
        return res.status(404).json({
          success: false,
          message: `Email ${email} belum terdaftar di database aplikasi.`
        });
      }
    } else if (type === 'forgot_password') {
      if (username) {
        const uDoc = await getDoc(doc(db, COLLECTIONS.USERS, username.toLowerCase()));
        if (uDoc.exists()) {
          matchedUser = { id: uDoc.id, ...uDoc.data() };
        }
      }
      if (!matchedUser) {
        const snap = await getDocs(collection(db, COLLECTIONS.USERS));
        for (const d of snap.docs) {
          const u = d.data();
          if (
            (email && u.email && u.email.trim().toLowerCase() === email) ||
            (username && u.username && u.username.trim().toLowerCase() === username.toLowerCase()) ||
            (username && d.id && d.id.trim().toLowerCase() === username.toLowerCase())
          ) {
            matchedUser = { id: d.id, ...u };
            break;
          }
        }
      }
      if (!matchedUser) {
        const fallbackUsers = [
          { username: 'kasir1', fullName: 'Siti Rahmawati', email: 'kasir1@istanabubur.com', role: 'Kasir' },
          { username: 'kasir2', fullName: 'Ahmad Fauzi', email: 'kasir2@istanabubur.com', role: 'Kasir' },
          { username: 'admin', fullName: 'Admin Pusat', email: 'istanabubur89@gmail.com', role: 'Admin' }
        ];
        const f = fallbackUsers.find(fu => 
          (username && fu.username.toLowerCase() === username.toLowerCase()) ||
          (email && fu.email.toLowerCase() === email)
        );
        if (f) {
          matchedUser = f;
        } else if (email) {
          matchedUser = {
            username: username || email.split('@')[0],
            fullName: username || 'Pengguna',
            email: email,
            role: 'Kasir'
          };
        }
      }
      if (!matchedUser) {
        return res.status(404).json({
          success: false,
          message: 'Akun dengan username atau email tersebut tidak ditemukan di database.'
        });
      }
    } else if (type === 'register') {
      if (username) {
        const uDoc = await getDoc(doc(db, COLLECTIONS.USERS, username.toLowerCase()));
        if (uDoc.exists()) {
          return res.status(400).json({
            success: false,
            message: 'Username sudah digunakan oleh akun lain. Silakan pilih username lain.'
          });
        }
      }
    }
  } catch (fsErr) {
    console.warn('[Firestore lookup warning in send-otp-email]:', fsErr);
  }

  // Generate 6-digit OTP
  const otp = String(crypto.randomInt(100000, 1000000));
  const otpHash = crypto.createHash('sha256').update(otp).digest('hex');
  const now = Date.now();
  const expiresAtMs = now + (10 * 60 * 1000); // 10 menit

  const storeKey = `${type}_${email}`;
  universalOtpStore.set(storeKey, {
    email,
    username: matchedUser?.username || username || '',
    type,
    otpHash,
    createdAtMs: now,
    expiresAtMs,
    used: false,
    userData: matchedUser
  });

  // Siapkan email
  let title = 'Verifikasi Pendaftaran Akun';
  let desc = 'Berikut adalah 6-digit kode OTP verifikasi email untuk pendaftaran akun Anda:';
  let subject = `[Istana Bubur] Kode OTP Verifikasi Pendaftaran: ${otp}`;

  if (type === 'forgot_username') {
    title = 'Bantuan Lupa Username';
    desc = 'Berikut adalah kode OTP verifikasi untuk melihat kembali username akun Anda:';
    subject = `[Istana Bubur] Kode OTP Pemulihan Username: ${otp}`;
  } else if (type === 'forgot_password') {
    title = 'Atur Ulang Password';
    desc = 'Berikut adalah kode OTP verifikasi untuk mengatur ulang kata sandi (password) akun Anda:';
    subject = `[Istana Bubur] Kode OTP Reset Password: ${otp}`;
  }

  const recipientName = matchedUser?.fullName || matchedUser?.username || username || 'Pengguna';

  const htmlContent = `
  <!DOCTYPE html>
  <html>
  <head><meta charset="utf-8"></head>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f8fafc; padding: 24px; margin: 0;">
    <div style="max-width: 500px; margin: 0 auto; background: #ffffff; border-radius: 16px; overflow: hidden; border: 1px solid #e2e8f0; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
      <div style="background: #dc2626; color: #ffffff; padding: 24px; text-align: center;">
        <h2 style="margin: 0; font-size: 22px; font-weight: 900; letter-spacing: 1px;">🥣 ISTANA BUBUR</h2>
        <p style="margin: 4px 0 0; font-size: 13px; color: #fee2e2;">${title}</p>
      </div>
      <div style="padding: 24px; color: #1e293b;">
        <p style="margin-top: 0;">Halo <strong>${recipientName}</strong>,</p>
        <p>${desc}</p>
        <div style="text-align: center; margin: 28px 0;">
          <div style="display: inline-block; background: #0f172a; color: #ffffff; font-family: monospace; font-size: 34px; font-weight: 900; letter-spacing: 8px; padding: 16px 32px; border-radius: 12px;">
            ${otp}
          </div>
          <p style="color: #dc2626; font-size: 12px; font-weight: 700; margin-top: 10px;">⏳ Berlaku selama 10 Menit</p>
        </div>
        <p style="font-size: 13px; color: #64748b; line-height: 1.5;">
          Jangan berikan kode ini kepada siapapun demi keamanan akun Anda.
        </p>
      </div>
      <div style="background: #f8fafc; border-top: 1px solid #f1f5f9; padding: 16px; text-align: center; font-size: 11px; color: #94a3b8;">
        Email otomatis dari Layanan Keamanan Istana Bubur.
      </div>
    </div>
  </body>
  </html>
  `;

  const textContent = `ISTANA BUBUR - ${title.toUpperCase()}

Halo ${recipientName},

${desc}

👉 ${otp} 👈

Kode OTP ini bersifat rahasia dan berlaku selama 10 menit.
Masukkan kode ini pada aplikasi untuk menyelesaikan verifikasi Anda.

💡 Tips: Jika Anda tidak menemukan email ini di Kotak Masuk (Inbox) utama Anda, harap periksa folder Spam atau Promosi.

--
Layanan Keamanan & Akun Istana Bubur
istanabubur89@gmail.com`;

  // Jika type register, sinkronkan juga ke referralCodesStore
  if (type === 'register') {
    referralCodesStore.set(email, {
      email,
      phone: '',
      username: recipientName,
      otpHash,
      createdAtMs: now,
      expiresAtMs,
      used: false
    });
  }

  try {
    const sendResult = await sendEmailWithFallback({
      to: email,
      subject,
      text: textContent,
      html: htmlContent
    });

    if (sendResult.success) {
      console.log(`[OTP SENT] Type: ${type}, To: ${email} via port ${sendResult.port}`);
      return res.json({
        success: true,
        delivered: true,
        expiresAt: expiresAtMs,
        message: `Kode OTP 6-digit berhasil dikirimkan ke email ${email}. Silakan periksa Kotak Masuk atau folder Spam email Anda.`
      });
    }

    console.warn(`[OTP SMTP Fallback] Email error: ${sendResult.error}`);
    return res.json({
      success: true,
      delivered: false,
      devMode: true,
      expiresAt: expiresAtMs,
      codeForTesting: otp,
      message: `Email verifikasi terkendala sementara (${sendResult.error}). Silakan coba kirim ulang atau gunakan verifikasi alternatif.`
    });
  } catch (err: any) {
    console.error('[SEND OTP EXCEPTION]:', err);
    return res.json({
      success: true,
      delivered: false,
      devMode: true,
      expiresAt: expiresAtMs,
      codeForTesting: otp,
      message: `Email verifikasi terkendala sementara. Silakan coba kirim ulang atau gunakan verifikasi alternatif.`
    });
  }
});

// Endpoint: Verifikasi Kode OTP (Universal)
app.post('/api/auth/verify-otp-email', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const code = String(req.body.code || '').trim();
  const type = String(req.body.type || 'register') as 'register' | 'forgot_username' | 'forgot_password';

  if (!email || !code || code.length !== 6) {
    return res.status(400).json({
      success: false,
      message: 'Email dan 6-digit kode OTP wajib diisi.'
    });
  }

  const storeKey = `${type}_${email}`;
  let record = universalOtpStore.get(storeKey);

  // Fallback ke referralCodesStore jika pendaftaran
  if (!record && type === 'register') {
    const ref = referralCodesStore.get(email);
    if (ref) {
      record = {
        email: ref.email,
        username: ref.username,
        type: 'register',
        otpHash: ref.otpHash,
        createdAtMs: ref.createdAtMs,
        expiresAtMs: ref.expiresAtMs,
        used: ref.used
      };
    }
  }

  if (!record) {
    return res.status(404).json({
      success: false,
      message: 'Kode OTP belum diminta atau tidak ditemukan. Silakan klik "Kirim Kode OTP".'
    });
  }

  if (Date.now() > record.expiresAtMs) {
    return res.status(410).json({
      success: false,
      message: 'Kode OTP telah kedaluwarsa (lebih dari 10 menit). Silakan klik "Kirim Ulang Kode".'
    });
  }

  const inputHash = crypto.createHash('sha256').update(code).digest('hex');
  if (inputHash !== record.otpHash) {
    return res.status(401).json({
      success: false,
      message: 'Kode OTP salah! Periksa kembali angka 6-digit yang tertera pada email Anda.'
    });
  }

  record.used = true;

  if (type === 'forgot_username') {
    return res.json({
      success: true,
      message: 'Kode OTP berhasil diverifikasi!',
      user: {
        username: record.userData?.username || record.username || 'user',
        fullName: record.userData?.fullName || record.userData?.username || 'Pengguna',
        email: record.email,
        role: record.userData?.role || 'Kasir',
        cabang: record.userData?.cabang || 'Cabang Utama'
      }
    });
  }

  return res.json({
    success: true,
    message: 'Kode OTP berhasil diverifikasi!'
  });
});

// Endpoint: Reset Password Akun di Firestore & Database
app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const username = String(req.body.username || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const newPassword = String(req.body.newPassword || '').trim();

    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'Password baru minimal 6 karakter!'
      });
    }

    if (!username && !email) {
      return res.status(400).json({
        success: false,
        message: 'Username atau email wajib disertakan untuk atur ulang password.'
      });
    }

    const { db, COLLECTIONS } = await import('./src/firebase.ts');
    const { doc, setDoc, getDoc, collection, getDocs } = await import('firebase/firestore');

    let targetDocId = '';
    let updatedUserObj: any = null;

    if (username) {
      const uDoc = await getDoc(doc(db, COLLECTIONS.USERS, username.toLowerCase()));
      if (uDoc.exists()) {
        targetDocId = username.toLowerCase();
        updatedUserObj = uDoc.data();
      }
    }

    if (!targetDocId && (email || username)) {
      const snap = await getDocs(collection(db, COLLECTIONS.USERS));
      for (const d of snap.docs) {
        const u = d.data();
        if (
          (email && u.email && u.email.trim().toLowerCase() === email) ||
          (username && u.username && u.username.trim().toLowerCase() === username.toLowerCase()) ||
          (username && d.id && d.id.trim().toLowerCase() === username.toLowerCase())
        ) {
          targetDocId = d.id;
          updatedUserObj = u;
          break;
        }
      }
    }

    if (!targetDocId) {
      // Fallback: check default users or initialize new document in Firestore
      const fallbackDefaults = [
        {
          id: 'USR-002',
          fullName: 'Siti Rahmawati',
          username: 'kasir1',
          email: 'kasir1@istanabubur.com',
          phone: '082198765432',
          role: 'Kasir',
          cabang: '',
          isActive: true,
          authCode: 'IB-AUTH-2026'
        },
        {
          id: 'USR-003',
          fullName: 'Ahmad Fauzi',
          username: 'kasir2',
          email: 'kasir2@istanabubur.com',
          phone: '085211223344',
          role: 'Kasir',
          cabang: '',
          isActive: true,
          authCode: 'IB-AUTH-2026'
        }
      ];
      const foundDef = fallbackDefaults.find(u => 
        (username && u.username.toLowerCase() === username.toLowerCase()) ||
        (email && u.email.toLowerCase() === email)
      );

      if (foundDef) {
        targetDocId = foundDef.username.toLowerCase();
        updatedUserObj = {
          ...foundDef,
          password: newPassword,
          createdAt: new Date().toISOString()
        };
        await setDoc(doc(db, COLLECTIONS.USERS, targetDocId), updatedUserObj);
      } else if (username || email) {
        targetDocId = (username || email.split('@')[0]).toLowerCase();
        updatedUserObj = {
          id: 'USR-' + Math.floor(100 + Math.random() * 900),
          username: username || targetDocId,
          email: email || '',
          password: newPassword,
          role: 'Kasir',
          cabang: 'Cabang Utama',
          isActive: true,
          createdAt: new Date().toISOString()
        };
        await setDoc(doc(db, COLLECTIONS.USERS, targetDocId), updatedUserObj);
      }
    }

    if (!targetDocId) {
      return res.status(404).json({
        success: false,
        message: 'Akun tidak ditemukan di Cloud Firestore.'
      });
    }

    await setDoc(doc(db, COLLECTIONS.USERS, targetDocId), {
      password: newPassword,
      updatedAt: new Date().toISOString()
    }, { merge: true });

    console.log(`[Firebase Firestore] Password untuk akun ${targetDocId} berhasil direset!`);

    return res.json({
      success: true,
      message: 'Password akun Anda berhasil diperbarui di Cloud Firestore!',
      username: updatedUserObj?.username || targetDocId
    });
  } catch (err: any) {
    console.error('Error in /api/auth/reset-password:', err);
    return res.status(500).json({
      success: false,
      message: err?.message || 'Gagal mengatur ulang password di server.'
    });
  }
});


async function startServer() {
  const server = http.createServer(app);

  // WebSocket Server Setup
  const wss = new WebSocketServer({ server, path: '/ws/chat' });

  wss.on('connection', (ws: WebSocket) => {
    const clientConn: ClientConnection = {
      ws,
      username: '',
      role: 'Kasir',
      cabang: 'Pusat'
    };
    clients.add(clientConn);

    ws.on('message', (raw) => {
      try {
        const data = JSON.parse(raw.toString());

        if (data.type === 'register') {
          clientConn.username = data.user?.username || 'User';
          clientConn.role = data.user?.role || 'Kasir';
          clientConn.cabang = data.user?.cabang || 'Pusat';

          // Send back initial chat history appropriate for this client
          let initialMsgs: ChatMessage[] = [];
          if (clientConn.role === 'Admin') {
            initialMsgs = chatMessages;
          } else {
            initialMsgs = chatMessages.filter(m => m.cabang === clientConn.cabang || m.cabang === 'Semua');
          }

          ws.send(JSON.stringify({
            type: 'init',
            messages: initialMsgs,
            onlineUsers: getOnlineSummary()
          }));

          // Notify everyone about online presence
          broadcast({
            type: 'presence',
            onlineUsers: getOnlineSummary()
          });
        } else if (data.type === 'chat_message') {
          const now = new Date();
          const hours = String(now.getHours()).padStart(2, '0');
          const minutes = String(now.getMinutes()).padStart(2, '0');

          const newMsg: ChatMessage = {
            id: data.id || ('msg-' + Date.now() + '-' + Math.floor(Math.random() * 1000)),
            cabang: data.cabang || clientConn.cabang,
            sender: clientConn.username || data.sender || 'Anonim',
            role: clientConn.role,
            text: String(data.text || '').trim(),
            timestamp: data.timestamp || now.toISOString(),
            formattedTime: data.formattedTime || `${hours}:${minutes}`
          };

          if (newMsg.text) {
            const existingIdx = chatMessages.findIndex(m => m.id === newMsg.id);
            if (existingIdx === -1) {
              chatMessages.push(newMsg);
            } else {
              chatMessages[existingIdx] = newMsg;
            }

            broadcast({
              type: 'new_message',
              message: newMsg
            }, (client) => {
              if (client.role === 'Admin') return true;
              return newMsg.cabang === 'Semua' || client.cabang === newMsg.cabang;
            });
          }
        } else if (data.type === 'typing') {
          broadcast({
            type: 'typing',
            sender: clientConn.username,
            role: clientConn.role,
            cabang: clientConn.cabang,
            isTyping: !!data.isTyping
          }, (client) => {
            if (client === clientConn) return false;
            if (client.role === 'Admin') return true;
            return client.cabang === clientConn.cabang;
          });
        } else if (data.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', time: Date.now() }));
        }
      } catch (e) {
        console.error('Error processing WS packet:', e);
      }
    });

    ws.on('close', () => {
      clients.delete(clientConn);
      broadcast({
        type: 'presence',
        onlineUsers: getOnlineSummary()
      });
    });

    ws.on('error', (err) => {
      console.error('WS client error:', err);
      clients.delete(clientConn);
    });
  });

  // Periodic ping to keep WebSocket connections alive on Cloud Run & mobile networks
  const wsHeartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.ping();
        } catch (e) {}
      }
    });
  }, 25000);

  server.on('close', () => {
    clearInterval(wsHeartbeatInterval);
  });

  // Vite middleware setup
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server & WebSocket running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
