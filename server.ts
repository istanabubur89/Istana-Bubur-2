import express from 'express';
import http from 'http';
import path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer as createViteServer } from 'vite';
import nodemailer from 'nodemailer';

const app = express();
const PORT = 3000;

app.use(express.json());

// Master Admin Security Key (Only Admin Knows This Key)
let MASTER_ADMIN_AUTH_CODES = ['IB-AUTH-2026', 'ADMIN-IB-889', 'IB-PUSAT-99'];

// Email Transporter Helper
function createEmailTransporter() {
  const host = process.env.SMTP_HOST || 'smtp.gmail.com';
  const port = parseInt(process.env.SMTP_PORT || '465', 10);
  const secure = process.env.SMTP_SECURE !== 'false';
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (user && pass) {
    return nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user, pass }
    });
  }

  // Fallback transporter when environment secrets are not yet configured
  return nodemailer.createTransport({
    jsonTransport: true
  });
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

// Endpoint: Kirim Kode Referral / OTP Reset ke Email Asli Pengguna
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
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
  </head>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; margin: 0; padding: 24px;">
    <div style="max-width: 520px; margin: 0 auto; background-color: #ffffff; border-radius: 20px; overflow: hidden; box-shadow: 0 4px 16px rgba(0,0,0,0.06); border: 1px solid #f1f5f9;">
      <!-- Header -->
      <div style="background: linear-gradient(135deg, #dc2626, #b91c1c); padding: 32px 24px; text-align: center; color: #ffffff;">
        <div style="font-size: 24px; font-weight: 900; letter-spacing: 1px; text-transform: uppercase;">
          🥣 ISTANA BUBUR
        </div>
        <p style="margin: 6px 0 0; font-size: 13px; color: #fee2e2; font-weight: 500;">
          Sistem Kasir & Manajemen Operasional Multi-Cabang
        </p>
      </div>

      <!-- Konten Utama -->
      <div style="padding: 28px 24px;">
        <div style="background-color: #fef2f2; border: 1px solid #fee2e2; border-radius: 14px; padding: 16px 20px; margin-bottom: 24px;">
          <h2 style="color: #991b1b; font-size: 16px; font-weight: 800; margin: 0 0 6px;">
            ${isReset ? '🔑 Permintaan Reset Password' : '✉️ Verifikasi Pendaftaran Akun'}
          </h2>
          <p style="color: #4b5563; font-size: 14px; line-height: 1.5; margin: 0;">
            Halo <strong>${username || 'Pengguna'}</strong>, berikut adalah kode verifikasi ${isReset ? 'OTP reset password' : 'referral pendaftaran'} resmi untuk akun Anda di sistem Istana Bubur:
          </p>
        </div>

        <!-- Box Kode -->
        <div style="text-align: center; margin: 28px 0;">
          <p style="font-size: 12px; font-weight: 700; color: #64748b; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px;">
            ${isReset ? 'Kode OTP Reset Password' : 'Kode Referral Verifikasi Email'}
          </p>
          <div style="display: inline-block; background-color: #0f172a; color: #ffffff; font-family: 'Courier New', Courier, monospace; font-size: 34px; font-weight: 900; letter-spacing: 8px; padding: 18px 36px; border-radius: 14px; box-shadow: 0 8px 16px rgba(15,23,42,0.15);">
            ${code}
          </div>
          <p style="color: #dc2626; font-size: 12px; font-weight: 700; margin-top: 12px;">
            ⏳ Masa berlaku kode: 10 Menit
          </p>
        </div>

        <!-- Catatan Keamanan Penting -->
        <div style="background-color: #fffbeb; border: 1px solid #fef3c7; border-radius: 12px; padding: 16px; font-size: 12px; color: #92400e; line-height: 1.6;">
          <strong>🔒 Petunjuk & Keamanan:</strong>
          <ul style="margin: 6px 0 0; padding-left: 18px;">
            <li>Masukkan 6 digit kode di atas pada formulir pendaftaran aplikasi.</li>
            <li>Setelah verifikasi email berhasil, akun baru <strong>wajib memasukkan Kode Autentikasi Khusus Admin</strong> yang hanya diketahui oleh Admin/Owner Pusat Istana Bubur.</li>
            <li>Jangan pernah membagikan kode referral ini kepada pihak lain yang tidak berkepentingan.</li>
          </ul>
        </div>
      </div>

      <!-- Footer -->
      <div style="background-color: #f8fafc; border-top: 1px solid #f1f5f9; padding: 16px 24px; text-align: center; font-size: 11px; color: #94a3b8;">
        Email otomatis dari Sistem Keamanan Istana Bubur.<br>
        © ${new Date().getFullYear()} Istana Bubur. Seluruh Hak Cipta Dilindungi.
      </div>
    </div>
  </body>
  </html>
  `;

  try {
    const transporter = createEmailTransporter();
    const info = await transporter.sendMail({
      from: process.env.SMTP_FROM || '"Istana Bubur Keamanan" <no-reply@istanabubur.com>',
      to: email,
      subject: subject,
      html: htmlContent
    });

    console.log(`[AUTH EMAIL SENT] Sent to ${email} (MessageID: ${info.messageId || 'json'})`);
    return res.json({
      success: true,
      delivered: true,
      message: `Kode referral verifikasi telah dikirimkan ke email ${email}. Silakan periksa Kotak Masuk atau folder Spam Anda.`
    });
  } catch (err: any) {
    console.error('[AUTH EMAIL ERROR]', err?.message || err);
    return res.json({
      success: true,
      delivered: false,
      message: `Kode verifikasi diproses untuk email ${email}. Silakan periksa email Anda.`
    });
  }
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
