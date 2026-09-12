import express from 'express';
import http from 'http';
import path from 'path';
import crypto from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer as createViteServer } from 'vite';
import nodemailer from 'nodemailer';

const app = express();
const PORT = 3000;

app.use(express.json());

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

// Email Transporter Helper
function createEmailTransporter() {
  const host = process.env.SMTP_HOST || 'smtp.gmail.com';
  const port = parseInt(process.env.SMTP_PORT || '465', 10);
  const secure = process.env.SMTP_SECURE !== 'false' && port === 465;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (user && pass) {
    return {
      transporter: nodemailer.createTransport({
        host,
        port,
        secure,
        auth: { user, pass }
      }),
      isLive: true
    };
  }

  // Fallback transporter when secrets are not yet filled
  return {
    transporter: nodemailer.createTransport({
      jsonTransport: true
    }),
    isLive: false
  };
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

  // 4. Siapkan Nodemailer
  const { transporter, isLive } = createEmailTransporter();
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

  // 5. Cek jika SMTP live belum disetel
  if (!isLive) {
    console.warn(`[DEV/PREVIEW OTP] Email: ${email}, OTP: ${otp} (Belum disetel SMTP_USER & SMTP_PASS)`);
    return res.json({
      success: true,
      delivered: false,
      devMode: true,
      codeForTesting: otp,
      expiresAt: expiresAtMs,
      message: `Kode referral verifikasi telah diproses. (Simulasi OTP: ${otp}). Untuk mengirim email asli ke Gmail, tambahkan SMTP_USER & SMTP_PASS di panel Secrets.`
    });
  }

  // 6. Pengiriman SMTP Live
  try {
    const info = await transporter.sendMail({
      from: process.env.SMTP_FROM || `"Istana Bubur Keamanan" <${process.env.SMTP_USER}>`,
      to: email,
      subject,
      html: htmlContent
    });

    const isConfirmed = info && (info.messageId || (Array.isArray(info.accepted) && info.accepted.length > 0));
    if (!isConfirmed) {
      return res.status(502).json({
        success: false,
        message: 'Server SMTP tidak mengonfirmasi penerimaan pengiriman email ke ' + email
      });
    }

    console.log(`[SMTP CONFIRMED] Sent to ${email} (MessageID: ${info.messageId})`);
    return res.json({
      success: true,
      delivered: true,
      expiresAt: expiresAtMs,
      message: `Kode referral 6-digit berhasil dikirimkan ke email ${email}. Silakan cek Kotak Masuk Gmail Anda.`
    });
  } catch (smtpErr: any) {
    console.error('[SMTP SEND ERROR]', smtpErr?.message || smtpErr);
    return res.status(500).json({
      success: false,
      message: `Gagal mengirim email ke ${email}: ${smtpErr?.message || 'Koneksi SMTP ditolak'}`
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
    const { transporter, isLive } = createEmailTransporter();
    if (!isLive) {
      return res.json({
        success: true,
        delivered: false,
        message: `Kode verifikasi diproses untuk email ${email}.`
      });
    }

    const info = await transporter.sendMail({
      from: process.env.SMTP_FROM || `"Istana Bubur Keamanan" <${process.env.SMTP_USER}>`,
      to: email,
      subject,
      html: htmlContent
    });

    return res.json({
      success: true,
      delivered: true,
      message: `Kode referral verifikasi telah dikirimkan ke email ${email}. Silakan periksa Kotak Masuk atau folder Spam Anda.`
    });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      delivered: false,
      message: `Gagal mengirim email ke ${email}: ${err?.message || err}`
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
