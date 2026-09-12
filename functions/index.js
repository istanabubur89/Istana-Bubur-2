/**
 * Firebase Cloud Functions - Istana Bubur
 * Function: sendReferralCode
 * 
 * Flow:
 * 1. Validates recipient email format
 * 2. Generates a cryptographic 6-digit OTP referral code
 * 3. Hashes the OTP using SHA-256 and stores with timestamp & 10-minute expiry in Firestore 'referralCodes' collection
 * 4. Connects to SMTP via Nodemailer using configured Cloud Functions secrets (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM)
 * 5. Sends email and ONLY returns success if SMTP server confirms delivery
 */

const functions = require('firebase-functions');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

if (!admin.apps.length) {
  admin.initializeApp();
}
const db = admin.firestore();

exports.sendReferralCode = functions
  .runWith({
    secrets: ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM']
  })
  .https.onCall(async (data, context) => {
    const email = String(data.email || '').trim().toLowerCase();
    const username = String(data.username || 'Pengguna').trim();

    // 1. Validasi format email
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!email || !emailRegex.test(email)) {
      throw new functions.https.HttpsError(
        'invalid-argument',
        'Alamat email tidak valid. Pastikan format email Anda benar (contoh: user@gmail.com).'
      );
    }

    // 2. Generate kode OTP 6-digit acak
    const otp = String(crypto.randomInt(100000, 1000000));
    const otpHash = crypto.createHash('sha256').update(otp).digest('hex');
    const now = Date.now();
    const expiresAtMs = now + (10 * 60 * 1000); // Berlaku 10 menit

    // 3. Simpan hash & metadata ke Firestore collection 'referralCodes'
    const referralDocRef = db.collection('referralCodes').doc(email);
    await referralDocRef.set({
      email: email,
      username: username,
      otpHash: otpHash,
      createdAtMs: now,
      expiresAtMs: expiresAtMs,
      used: false,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // 4. Inisialisasi transporter SMTP menggunakan secrets
    const host = process.env.SMTP_HOST || 'smtp.gmail.com';
    const port = parseInt(process.env.SMTP_PORT || '465', 10);
    const secure = port === 465;
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    const from = process.env.SMTP_FROM || `"Istana Bubur Keamanan" <${user || 'no-reply@istanabubur.com'}>`;

    if (!user || !pass) {
      console.error('[sendReferralCode] Kredensial SMTP_USER atau SMTP_PASS belum disetel di secrets.');
      throw new functions.https.HttpsError(
        'failed-precondition',
        'Konfigurasi SMTP email belum disetel di server secrets. Harap hubungi administrator sistem.'
      );
    }

    const transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user, pass }
    });

    const mailOptions = {
      from,
      to: email,
      subject: `[Istana Bubur] Kode Referral Verifikasi: ${otp}`,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <style>
            body { font-family: Arial, sans-serif; background-color: #f8fafc; padding: 20px; }
            .card { max-width: 500px; margin: auto; background: #ffffff; border-radius: 16px; overflow: hidden; border: 1px solid #e2e8f0; }
            .header { background: #dc2626; color: #ffffff; padding: 24px; text-align: center; }
            .content { padding: 24px; color: #1e293b; }
            .otp-box { text-align: center; margin: 24px 0; }
            .otp-code { font-size: 32px; font-weight: bold; letter-spacing: 8px; font-family: monospace; background: #0f172a; color: #ffffff; padding: 14px 28px; border-radius: 10px; display: inline-block; }
            .footer { padding: 16px; text-align: center; font-size: 11px; color: #94a3b8; background: #f8fafc; }
          </style>
        </head>
        <body>
          <div class="card">
            <div class="header">
              <h2 style="margin:0; font-size:20px; letter-spacing:1px;">ISTANA BUBUR</h2>
              <p style="margin:4px 0 0; font-size:12px; opacity:0.9;">Verifikasi Email Pendaftaran Akun</p>
            </div>
            <div class="content">
              <p>Halo <b>${username}</b>,</p>
              <p>Berikut adalah 6-digit kode referral verifikasi email untuk pendaftaran akun Anda:</p>
              <div class="otp-box">
                <div class="otp-code">${otp}</div>
                <p style="color: #dc2626; font-size: 12px; font-weight: bold; margin-top: 10px;">⏳ Berlaku selama 10 Menit</p>
              </div>
              <p style="font-size: 13px; color: #64748b;">
                Setelah verifikasi kode ini, Anda akan diarahkan ke tahap pengisian Kode Autentikasi Admin untuk mengaktifkan akun Anda.
              </p>
            </div>
            <div class="footer">
              Email otomatis dari Sistem Istana Bubur. Jangan balas email ini.
            </div>
          </div>
        </body>
        </html>
      `
    };

    // 5. Kirim email dan pastikan konfirmasi dari SMTP server
    try {
      const info = await transporter.sendMail(mailOptions);
      // Validasi konfirmasi SMTP
      const isAccepted = info && ((Array.isArray(info.accepted) && info.accepted.length > 0) || info.messageId);
      if (!isAccepted) {
        throw new Error('Server SMTP tidak memberikan konfirmasi pengiriman.');
      }

      return {
        success: true,
        expiresAtMs: expiresAtMs,
        messageId: info.messageId,
        message: `Kode referral 6-digit berhasil dikirimkan ke alamat ${email}. Silakan cek kotak masuk Gmail Anda.`
      };
    } catch (sendErr) {
      console.error('[sendReferralCode SMTP Error]:', sendErr);
      throw new functions.https.HttpsError(
        'internal',
        `Pengiriman email ke ${email} gagal melalui SMTP: ${sendErr.message || 'Koneksi ditolak'}`
      );
    }
  });

/**
 * Cloud Function: verifyReferralCode
 * Verifies submitted OTP against SHA-256 hash in Firestore
 */
exports.verifyReferralCode = functions.https.onCall(async (data, context) => {
  const email = String(data.email || '').trim().toLowerCase();
  const code = String(data.code || '').trim();

  if (!email || !code || code.length !== 6) {
    throw new functions.https.HttpsError('invalid-argument', 'Email dan 6 digit kode harus diisi.');
  }

  const docSnap = await db.collection('referralCodes').doc(email).get();
  if (!docSnap.exists) {
    throw new functions.https.HttpsError('not-found', 'Kode referral belum pernah dikirimkan untuk email ini.');
  }

  const refData = docSnap.data();
  if (refData.used) {
    throw new functions.https.HttpsError('failed-precondition', 'Kode referral ini sudah pernah digunakan.');
  }

  if (Date.now() > refData.expiresAtMs) {
    throw new functions.https.HttpsError('deadline-exceeded', 'Kode referral telah kedaluwarsa (lebih dari 10 menit). Silakan minta kode baru.');
  }

  const inputHash = crypto.createHash('sha256').update(code).digest('hex');
  if (inputHash !== refData.otpHash) {
    throw new functions.https.HttpsError('permission-denied', 'Kode referral salah. Silakan periksa kembali email Anda.');
  }

  // Tandai kode sudah digunakan
  await db.collection('referralCodes').doc(email).update({
    used: true,
    usedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  return {
    success: true,
    message: 'Kode referral email berhasil diverifikasi.'
  };
});
