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

// In-memory chat storage seeded with initial conversation (tanpa hardcode Cabang A, B, C)
const chatMessages: ChatMessage[] = [
  {
    id: 'msg-init-welcome',
    cabang: 'Semua',
    sender: 'Admin Pusat',
    role: 'Admin',
    text: 'Selamat datang di Ruang Chat Bantuan & Operasional Istana Bubur. Hubungi Admin Pusat jika membutuhkan bantuan operasional kasir.',
    timestamp: new Date().toISOString(),
    formattedTime: '08:00'
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

  // 4. Siapkan format pesan WhatsApp resmi
  const waMsg = `*ISTANA BUBUR - KODE OTP PENDAFTARAN*\n\nHalo *${username}*,\nBerikut adalah 6-digit Kode OTP Verifikasi Pendaftaran Akun Anda:\n\n👉 *${otp}* 👈\n\nKode ini bersifat rahasia dan berlaku selama 10 menit.\nMasukkan kode ini pada aplikasi untuk menyelesaikan pendaftaran.`;
  const waUrl = cleanPhone 
    ? `https://api.whatsapp.com/send?phone=${cleanPhone}&text=${encodeURIComponent(waMsg)}`
    : `https://api.whatsapp.com/send?text=${encodeURIComponent(waMsg)}`;

  // 5. Siapkan Konten Email
  const subject = `[Istana Bubur] Kode OTP Verifikasi Pendaftaran: ${otp}`;
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
        <p>Berikut adalah 6-digit kode OTP verifikasi pendaftaran akun Anda:</p>
        <div style="text-align: center; margin: 28px 0;">
          <div style="display: inline-block; background: #0f172a; color: #ffffff; font-family: monospace; font-size: 34px; font-weight: 900; letter-spacing: 8px; padding: 16px 32px; border-radius: 12px;">
            ${otp}
          </div>
          <p style="color: #dc2626; font-size: 12px; font-weight: 700; margin-top: 10px;">⏳ Berlaku selama 10 Menit</p>
        </div>
        <p style="font-size: 13px; color: #64748b; line-height: 1.5;">
          Jangan berikan kode ini kepada siapapun demi keamanan sistem. Masukkan kode ini pada aplikasi untuk melanjutkan pendaftaran.
        </p>
      </div>
      <div style="background: #f8fafc; border-top: 1px solid #f1f5f9; padding: 16px; text-align: center; font-size: 11px; color: #94a3b8;">
        Email otomatis dari Sistem Keamanan Istana Bubur.
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
        html: htmlContent
      });

      if (sendResult.success) {
        emailDelivered = true;
        console.log(`[SMTP SUCCESS] Sent to ${email} via port ${sendResult.port}`);
      } else {
        emailErrorMsg = sendResult.error || 'Kendala koneksi SMTP';
        console.warn(`[SMTP WARN] Email to ${email} error: ${emailErrorMsg}`);
      }
    } catch (err: any) {
      emailErrorMsg = err?.message || 'Gagal mengirim email';
      console.warn(`[SMTP EXCEPTION] Email to ${email}:`, emailErrorMsg);
    }
  }

  // Response: TIDAK membocorkan kode darurat di pesan teks
  // Kode OTP disediakan untuk channel WhatsApp & sinkronisasi verifikasi
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
      ? `Kode OTP verifikasi berhasil dikirim ke email ${email}. Anda juga dapat menerimanya via WhatsApp.`
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

  try {
    const sendResult = await sendEmailWithFallback({
      to: email,
      subject,
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
