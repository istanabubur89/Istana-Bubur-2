/**
 * Firebase Cloud Functions - Istana Bubur
 * 
 * Functions:
 * 1. sendReferralCode (Callable & HTTP):
 *    - Generates 6-digit random referral code
 *    - Checks rate limiting (cooldown per email to prevent abuse)
 *    - Hashes code with SHA-256 and stores with 10-minute expiry in Firestore
 *    - Immediately invalidates previous codes
 *    - Sends email via SMTP (Nodemailer) with credentials stored in Firebase Secrets
 *    - Also writes to 'mail' collection for Firebase Extension "Trigger Email" compatibility
 *    - Never exposes secrets, passwords, or raw credentials in responses or errors
 * 
 * 2. verifyReferralCode (Callable & HTTP):
 *    - Validates 6-digit code against hash
 *    - Checks 10-minute expiry and usage status
 *    - Marks code as used
 * 
 * 3. api (HTTPS onRequest):
 *    - Express API for Firebase Hosting rewrites (/api/**)
 */

const functions = require('firebase-functions');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');

if (!admin.apps.length) {
  admin.initializeApp();
}
const db = admin.firestore();

// -------------------------------------------------------------
// HELPER: Generate and Send Referral OTP
// -------------------------------------------------------------
async function handleSendReferralCode(rawEmail, rawUsername) {
  const email = String(rawEmail || '').trim().toLowerCase();
  const username = String(rawUsername || 'Pengguna').trim();

  // 1. Validasi format email
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!email || !emailRegex.test(email)) {
    throw new Error('Format email tidak valid. Pastikan format email benar (contoh: user@gmail.com).');
  }

  const now = Date.now();
  const referralDocRef = db.collection('referralCodes').doc(email);

  // 2. Batas pengiriman ulang (Rate Limit / Cooldown 60 detik)
  const existingDoc = await referralDocRef.get();
  if (existingDoc.exists) {
    const data = existingDoc.data();
    if (data.createdAtMs && (now - data.createdAtMs < 60000)) {
      const waitSec = Math.ceil((60000 - (now - data.createdAtMs)) / 1000);
      throw new Error(`Batas pengiriman ulang aktif. Harap tunggu ${waitSec} detik sebelum meminta kode baru.`);
    }
  }

  // 3. Buat kode 6 digit secara acak (berbeda setiap kali)
  const otp = String(crypto.randomInt(100000, 1000000));
  const otpHash = crypto.createHash('sha256').update(otp).digest('hex');
  const expiresAtMs = now + (10 * 60 * 1000); // Masa berlaku 10 menit

  // 4. Simpan ke Firestore (saat meminta kode baru, kode lama langsung tertimpa/tidak berlaku)
  await referralDocRef.set({
    email,
    username,
    otpHash,
    createdAtMs: now,
    expiresAtMs,
    used: false,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  // 5. Template Email HTML Ramah & Profesional
  const emailSubject = `[Istana Bubur] Kode Referral Verifikasi: ${otp}`;
  const emailHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; padding: 20px; margin: 0; }
        .card { max-width: 480px; margin: auto; background: #ffffff; border-radius: 20px; overflow: hidden; border: 1px solid #e2e8f0; box-shadow: 0 4px 12px rgba(0,0,0,0.05); }
        .header { background: linear-gradient(135deg, #dc2626, #b91c1c); color: #ffffff; padding: 28px 24px; text-align: center; }
        .content { padding: 28px 24px; color: #1e293b; line-height: 1.6; }
        .otp-box { text-align: center; margin: 24px 0; }
        .otp-code { font-size: 34px; font-weight: 900; letter-spacing: 8px; font-family: 'Courier New', monospace; background: #0f172a; color: #ffffff; padding: 14px 28px; border-radius: 14px; display: inline-block; }
        .badge-exp { display: inline-block; margin-top: 10px; color: #dc2626; font-size: 12px; font-weight: 800; background: #fef2f2; padding: 4px 12px; border-radius: 999px; }
        .footer { padding: 18px 24px; text-align: center; font-size: 11px; color: #94a3b8; background: #f8fafc; border-top: 1px solid #f1f5f9; }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="header">
          <h2 style="margin:0; font-size:22px; letter-spacing:1px; font-weight:900;">ISTANA BUBUR</h2>
          <p style="margin:6px 0 0; font-size:12px; opacity:0.95;">Verifikasi Kode Referral Pendaftaran</p>
        </div>
        <div class="content">
          <p>Halo <b>${username}</b>,</p>
          <p>Berikut adalah 6-digit kode referral verifikasi pendaftaran akun Anda di sistem Istana Bubur:</p>
          <div class="otp-box">
            <div class="otp-code">${otp}</div>
            <div><span class="badge-exp">⏳ Masa Berlaku: 10 Menit</span></div>
          </div>
          <p style="font-size: 12px; color: #64748b; margin-top: 20px;">
            Masukkan kode ini pada aplikasi untuk melanjutkan proses autentikasi akun. Jika Anda tidak merasa meminta kode ini, silakan abaikan pesan ini.
          </p>
        </div>
        <div class="footer">
          Email otomatis dari Keamanan Sistem Istana Bubur &bull; Jangan balas email ini.
        </div>
      </div>
    </body>
    </html>
  `;

  // 6. Sinkronisasi ke koleksi 'mail' untuk Firebase Extension "Trigger Email"
  try {
    await db.collection('mail').add({
      to: [email],
      message: {
        subject: emailSubject,
        html: emailHtml,
        text: `Halo ${username},\n\nKode referral verifikasi Anda di Istana Bubur adalah: ${otp}\n\nKode ini berlaku selama 10 menit.\nJangan berikan kode ini kepada siapa pun.`
      },
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (extErr) {
    console.warn('[Trigger Email Collection Log]:', extErr.message);
  }

  // 7. Pengiriman langsung melalui Nodemailer via Secret Environment
  const host = process.env.SMTP_HOST || 'smtp.gmail.com';
  const port = parseInt(process.env.SMTP_PORT || '465', 10);
  const secure = port === 465;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM || `"Istana Bubur Keamanan" <${user || 'no-reply@istanabubur.com'}>`;

  if (user && pass) {
    const transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user, pass }
    });

    try {
      await transporter.sendMail({
        from,
        to: email,
        subject: emailSubject,
        html: emailHtml
      });
    } catch (mailErr) {
      console.error('[sendReferralCode SMTP delivery error]:', mailErr.message);
      // Jangan pernah menampilkan kredensial/password ke output error
      throw new Error(`Pengiriman email ke ${email} gagal melalui server SMTP. Pastikan alamat email benar.`);
    }
  }

  return {
    success: true,
    status: 'Terkirim',
    email,
    expiresAtMs,
    message: 'Terkirim'
  };
}

// -------------------------------------------------------------
// HELPER: Verify Referral OTP
// -------------------------------------------------------------
async function handleVerifyReferralCode(rawEmail, rawCode) {
  const email = String(rawEmail || '').trim().toLowerCase();
  const code = String(rawCode || '').trim();

  if (!email || !code || code.length !== 6) {
    throw new Error('Email dan 6-digit kode referral harus diisi.');
  }

  const docSnap = await db.collection('referralCodes').doc(email).get();
  if (!docSnap.exists) {
    throw new Error('Kode referral belum pernah diminta untuk email ini. Silakan minta kode baru.');
  }

  const data = docSnap.data();
  if (data.used) {
    throw new Error('Kode referral ini sudah pernah digunakan. Silakan minta kode baru.');
  }

  if (Date.now() > data.expiresAtMs) {
    throw new Error('Kode referral telah kedaluwarsa (masa berlaku 10 menit telah habis). Silakan minta kode baru.');
  }

  const inputHash = crypto.createHash('sha256').update(code).digest('hex');
  if (inputHash !== data.otpHash) {
    throw new Error('Kode referral salah. Silakan periksa kembali email Anda.');
  }

  // Tandai kode sudah digunakan
  await db.collection('referralCodes').doc(email).update({
    used: true,
    usedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  return {
    success: true,
    message: 'Kode referral berhasil diverifikasi. Silakan lanjutkan pendaftaran akun.'
  };
}

// -------------------------------------------------------------
// 1. FIREBASE CALLABLE CLOUD FUNCTIONS
// -------------------------------------------------------------
exports.sendReferralCode = functions
  .runWith({
    secrets: ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM']
  })
  .https.onCall(async (data, context) => {
    try {
      return await handleSendReferralCode(data?.email, data?.username);
    } catch (err) {
      throw new functions.https.HttpsError('internal', err.message || 'Gagal memproses kode referral.');
    }
  });

exports.verifyReferralCode = functions.https.onCall(async (data, context) => {
  try {
    return await handleVerifyReferralCode(data?.email, data?.code);
  } catch (err) {
    throw new functions.https.HttpsError('invalid-argument', err.message || 'Kode referral tidak valid.');
  }
});

// -------------------------------------------------------------
// 2. EXPRESS HTTP API (For Firebase Hosting Rewrites /api/**)
// -------------------------------------------------------------
const apiApp = express();
apiApp.use(cors({ origin: true }));
apiApp.use(express.json());

apiApp.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'Istana Bubur Cloud Functions', timestamp: new Date().toISOString() });
});

apiApp.post('/api/auth/send-referral-code', async (req, res) => {
  try {
    const result = await handleSendReferralCode(req.body.email, req.body.username);
    return res.json(result);
  } catch (err) {
    return res.status(400).json({ success: false, message: err.message });
  }
});

apiApp.post('/api/auth/verify-referral-code', async (req, res) => {
  try {
    const result = await handleVerifyReferralCode(req.body.email, req.body.code);
    return res.json(result);
  } catch (err) {
    return res.status(400).json({ success: false, message: err.message });
  }
});

exports.api = functions
  .runWith({
    secrets: ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM']
  })
  .https.onRequest(apiApp);
