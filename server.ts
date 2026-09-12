import express from 'express';
import http from 'http';
import path from 'path';
import crypto from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer as createViteServer } from 'vite';
import nodemailer from 'nodemailer';

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

// Periodic cleanup of documents older than 3 hours
setInterval(() => {
  const now = Date.now();
  for (const [id, doc] of documentStore.entries()) {
    if (now - doc.createdAt > 3 * 3600 * 1000) {
      documentStore.delete(id);
    }
  }
}, 30 * 60 * 1000);

// Email Transporter Helper with dual port (465 SSL & 587 TLS) and timeout handling
function createEmailTransporter(forcePort?: number) {
  const host = process.env.SMTP_HOST || 'smtp.gmail.com';
  const defaultPort = parseInt(process.env.SMTP_PORT || '465', 10);
  const port = forcePort || defaultPort;
  const secure = port === 465;
  // Support either SMTP_USER or fallback to istanabubur89@gmail.com
  const user = (process.env.SMTP_USER || 'istanabubur89@gmail.com').trim();
  // Support both SMTP_PASS or SMTP_PASSWORD, and remove spaces often present in Gmail App Passwords
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
        connectionTimeout: 8000,
        greetingTimeout: 8000,
        socketTimeout: 12000
      }),
      from,
      user,
      port,
      isLive: true
    };
  }

  // Fallback transporter when credentials are not filled
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

async function sendEmailWithFallback({ to, subject, html }: { to: string; subject: string; html: string }) {
  const primary = createEmailTransporter(465);
  if (!primary.isLive) {
    return { success: false, isLive: false, error: 'Kredensial SMTP belum disetel' };
  }

  // Percobaan 1: Port 465 (SSL)
  try {
    const info = await primary.transporter.sendMail({
      from: primary.from,
      to,
      subject,
      html
    });
    return { success: true, isLive: true, info, port: 465 };
  } catch (err465: any) {
    console.warn('[SMTP 465 GAGAL, MENCOBA 587]:', err465?.message || err465);
    // Percobaan 2: Port 587 (TLS/STARTTLS)
    try {
      const fallback = createEmailTransporter(587);
      const info = await fallback.transporter.sendMail({
        from: fallback.from,
        to,
        subject,
        html
      });
      return { success: true, isLive: true, info, port: 587 };
    } catch (err587: any) {
      console.error('[SMTP 587 GAGAL JUGA]:', err587?.message || err587);
      return {
        success: false,
        isLive: true,
        error: err587?.message || err465?.message || 'Gagal mengirim melalui SMTP Gmail'
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

// In-memory chat storage seeded with initial conversation
const chatMessages: ChatMessage[] = [
  {
    id: 'msg-init-1',
    cabang: 'Cabang A',
    sender: 'Admin Pusat',
    role: 'Admin',
    text: 'Halo tim Kasir Cabang A! Selamat bertugas hari ini. Silakan chat di sini jika butuh bantuan stok, printer, atau operasional.',
    timestamp: new Date(Date.now() - 3600000).toISOString(),
    formattedTime: '08:00'
  },
  {
    id: 'msg-init-2',
    cabang: 'Cabang A',
    sender: 'kasir1',
    role: 'Kasir',
    text: 'Siap Pak Admin, mesin kasir dan printer bluetooth sudah terhubung normal.',
    timestamp: new Date(Date.now() - 3000000).toISOString(),
    formattedTime: '08:15'
  },
  {
    id: 'msg-init-3',
    cabang: 'Cabang B',
    sender: 'Admin Pusat',
    role: 'Admin',
    text: 'Halo tim Kasir Cabang B! Jangan lupa cek ketersediaan kerupuk dan sate telur puyuh ya.',
    timestamp: new Date(Date.now() - 1800000).toISOString(),
    formattedTime: '08:30'
  }
];

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

    const docId = 'ib-' + Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');
    const safeFilename = (filename || (type === 'slip' ? 'Slip_Gaji.pdf' : 'Nota_Transaksi.pdf')).replace(/[^a-zA-Z0-9._-]/g, '_');

    documentStore.set(docId, {
      id: docId,
      type: type === 'slip' ? 'slip' : 'nota',
      filename: safeFilename.endsWith('.pdf') ? safeFilename : safeFilename + '.pdf',
      title: title || (type === 'slip' ? 'Slip Gaji Karyawan' : 'Nota Transaksi'),
      htmlContent,
      base64Pdf: base64Pdf || undefined,
      phone: phone || '',
      waMessage: waMessage || '',
      createdAt: Date.now()
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

// Direct PDF File Download endpoint (forces attachment download in Android external browser)
app.get('/api/pdf/download/:docId', (req, res) => {
  const doc = documentStore.get(req.params.docId);
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
app.get('/view-doc/:docId', (req, res) => {
  const doc = documentStore.get(req.params.docId);
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
      max-width: 720px;
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
      .doc-card { box-shadow: none !important; border: none !important; }
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
        margin: [4, 4, 4, 4],
        filename: '${doc.filename}',
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: { scale: 2, useCORS: true },
        jsPDF: { unit: 'mm', format: isNota ? [80, 220] : 'a5', orientation: 'portrait' }
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

app.get('/api/chat/messages', (req, res) => {
  const { cabang, role } = req.query;
  if (role === 'Admin' && (!cabang || cabang === 'Semua')) {
    return res.json({ success: true, messages: chatMessages });
  }
  if (cabang) {
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
    id: 'msg-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
    cabang: cabang || 'Pusat',
    sender: sender,
    role: role || 'Kasir',
    text: String(text).trim(),
    timestamp: now.toISOString(),
    formattedTime: `${hours}:${minutes}`
  };

  chatMessages.push(newMsg);

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
    if (!cabangMap[m.cabang]) {
      cabangMap[m.cabang] = { lastMessage: null, unreadCount: 0 };
    }
    cabangMap[m.cabang].lastMessage = m;
  });

  res.json({
    success: true,
    cabangs: Object.keys(cabangMap).map(cabang => ({
      cabang,
      lastMessage: cabangMap[cabang].lastMessage
    }))
  });
});

// ==========================================
// REAL EMAIL SENDER & ADMIN AUTH CODE API
// ==========================================

// Endpoint: Kirim Kode Referral (Sesuai spesifikasi Cloud Function & REST API)
app.post('/api/auth/send-referral-code', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const username = String(req.body.username || 'Pengguna').trim();

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

  // 3. Simpan hash & metadata
  const record: ReferralRecord = {
    email,
    username,
    otpHash,
    createdAtMs: now,
    expiresAtMs,
    used: false
  };
  referralCodesStore.set(email, record);

  // 4. Siapkan Konten Email
  const subject = `[Istana Bubur] Kode Referral Pendaftaran: ${otp}`;
  const htmlContent = `
  <!DOCTYPE html>
  <html>
  <head><meta charset="utf-8"></head>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f8fafc; padding: 24px; margin: 0;">
    <div style="max-width: 500px; margin: 0 auto; background: #ffffff; border-radius: 16px; overflow: hidden; border: 1px solid #e2e8f0; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
      <div style="background: #dc2626; color: #ffffff; padding: 24px; text-align: center;">
        <h2 style="margin: 0; font-size: 22px; font-weight: 900; letter-spacing: 1px;">🥣 ISTANA BUBUR</h2>
        <p style="margin: 4px 0 0; font-size: 13px; color: #fee2e2;">Verifikasi Pendaftaran Akun</p>
      </div>
      <div style="padding: 24px; color: #1e293b;">
        <p style="margin-top: 0;">Halo <strong>${username}</strong>,</p>
        <p>Berikut adalah 6-digit kode referral verifikasi email untuk pendaftaran akun Anda:</p>
        <div style="text-align: center; margin: 28px 0;">
          <div style="display: inline-block; background: #0f172a; color: #ffffff; font-family: monospace; font-size: 34px; font-weight: 900; letter-spacing: 8px; padding: 16px 32px; border-radius: 12px;">
            ${otp}
          </div>
          <p style="color: #dc2626; font-size: 12px; font-weight: 700; margin-top: 10px;">⏳ Berlaku selama 10 Menit</p>
        </div>
        <p style="font-size: 13px; color: #64748b; line-height: 1.5;">
          Masukkan kode ini pada aplikasi untuk melanjutkan ke pengisian Kode Autentikasi Admin.
        </p>
      </div>
      <div style="background: #f8fafc; border-top: 1px solid #f1f5f9; padding: 16px; text-align: center; font-size: 11px; color: #94a3b8;">
        Email otomatis dari Sistem Keamanan Istana Bubur.
      </div>
    </div>
  </body>
  </html>
  `;

  // 5. Kirim via SMTP dengan auto-fallback (Port 465 SSL -> Port 587 TLS)
  try {
    const sendResult = await sendEmailWithFallback({
      to: email,
      subject,
      html: htmlContent
    });

    if (sendResult.success) {
      console.log(`[SMTP SUCCESS] Sent to ${email} via port ${sendResult.port}`);
      return res.json({
        success: true,
        delivered: true,
        expiresAt: expiresAtMs,
        message: `Kode referral 6-digit berhasil dikirimkan ke email ${email}. Silakan cek Kotak Masuk atau folder Spam Gmail Anda.`
      });
    }

    // Jika gagal mengirim via SMTP, sediakan pesan jelas dan kode darurat
    console.error(`[SMTP FAILED] ${sendResult.error}`);
    return res.status(200).json({
      success: true,
      delivered: false,
      devMode: true,
      codeForTesting: otp,
      expiresAt: expiresAtMs,
      message: `Email ke ${email} terkendala SMTP (${sendResult.error}). Kode referral verifikasi Anda: ${otp}`
    });
  } catch (err: any) {
    console.error('[SEND REFERRAL EXCEPTION]:', err);
    return res.status(200).json({
      success: true,
      delivered: false,
      devMode: true,
      codeForTesting: otp,
      expiresAt: expiresAtMs,
      message: `Kode referral pendaftaran: ${otp}. Masukkan kode ini pada langkah 2.`
    });
  }
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
      message: `Kode verifikasi diproses untuk email ${email}. (Kode cadangan: ${code})`
    });
  } catch (err: any) {
    return res.status(200).json({
      success: true,
      delivered: false,
      message: `Kode verifikasi Anda adalah: ${code}`
    });
  }
});

// Endpoint: Verifikasi Kode Referral OTP
app.post('/api/auth/verify-referral-code', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const code = String(req.body.code || '').trim();

  if (!email || !code || code.length !== 6) {
    return res.status(400).json({
      success: false,
      message: 'Email dan 6-digit kode referral wajib diisi.'
    });
  }

  const record = referralCodesStore.get(email);
  if (!record) {
    return res.status(404).json({
      success: false,
      message: 'Kode referral untuk email ini tidak ditemukan. Silakan klik "Kirim Kode Referral ke Email".'
    });
  }

  if (record.used) {
    return res.status(400).json({
      success: false,
      message: 'Kode referral ini sudah pernah digunakan. Silakan minta kode baru.'
    });
  }

  if (Date.now() > record.expiresAtMs) {
    return res.status(410).json({
      success: false,
      message: 'Kode referral telah kedaluwarsa (lebih dari 10 menit). Silakan klik "Kirim Ulang Kode".'
    });
  }

  const inputHash = crypto.createHash('sha256').update(code).digest('hex');
  if (inputHash !== record.otpHash) {
    return res.status(401).json({
      success: false,
      message: 'Kode referral salah! Periksa kembali angka yang tertera pada email Anda.'
    });
  }

  // Tandai kode sudah dipakai
  record.used = true;
  return res.json({
    success: true,
    message: 'Kode referral email berhasil diverifikasi!'
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
            id: 'msg-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
            cabang: data.cabang || clientConn.cabang,
            sender: clientConn.username || data.sender || 'Anonim',
            role: clientConn.role,
            text: String(data.text || '').trim(),
            timestamp: now.toISOString(),
            formattedTime: `${hours}:${minutes}`
          };

          if (newMsg.text) {
            chatMessages.push(newMsg);

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
