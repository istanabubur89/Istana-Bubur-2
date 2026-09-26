/**
 * Google Drive Integration for Istana Bubur
 * Uploads Nota Transaksi and Slip Gaji PDFs to Google Drive
 * Generates direct download links for WhatsApp sharing
 */
import { getAuth, signInWithPopup, GoogleAuthProvider, onAuthStateChanged, User, signOut } from 'firebase/auth';
import { app } from './firebase';

export const SCOPES = [
  'https://www.googleapis.com/auth/drive.file'
];

export const DEFAULT_GDRIVE_FOLDER_ID = '1-Q_CN5nca3vKCMNH9ljM0p3BMalHwcGw';

const auth = getAuth(app);
const provider = new GoogleAuthProvider();
SCOPES.forEach(scope => provider.addScope(scope));

// In-memory token cache (MUST NOT store in localStorage or sessionStorage)
let cachedAccessToken: string | null = null;
let currentUser: User | null = null;
let isSigningIn = false;

type AuthCallback = (user: User | null, token: string | null) => void;
const authListeners: AuthCallback[] = [];

export function onGoogleAuthStateChange(cb: AuthCallback): () => void {
  authListeners.push(cb);
  cb(currentUser, cachedAccessToken);
  return () => {
    const idx = authListeners.indexOf(cb);
    if (idx !== -1) authListeners.splice(idx, 1);
  };
}

function notifyListeners() {
  authListeners.forEach(cb => {
    try {
      cb(currentUser, cachedAccessToken);
    } catch (e) {
      console.error('Google auth listener error:', e);
    }
  });
}

export async function syncTokenWithServer(): Promise<string | null> {
  if (typeof window === 'undefined') return null;
  try {
    const res = await fetch('/api/gdrive/session');
    if (res.ok) {
      const data = await res.json();
      if (data && data.connected && data.token) {
        cachedAccessToken = data.token;
        notifyListeners();
        return data.token;
      }
    }
  } catch (e) {
    console.warn('Failed to sync gdrive token from server:', e);
  }
  return cachedAccessToken;
}

// Initialize Auth listener and Server Token sync on startup
if (typeof window !== 'undefined') {
  onAuthStateChanged(auth, (user) => {
    currentUser = user;
    if (!user && !cachedAccessToken) {
      cachedAccessToken = null;
    }
    notifyListeners();
  });

  // Sync token from server for Android WebView APK on startup
  syncTokenWithServer();

  // Listen for WebSocket broadcast of GDRIVE_SYNC
  window.addEventListener('message', (ev) => {
    if (ev.data && ev.data.type === 'GDRIVE_SYNC' && ev.data.token) {
      cachedAccessToken = ev.data.token;
      notifyListeners();
    }
  });
}

export async function signInGoogleDrive(): Promise<{ user: User | null; accessToken: string }> {
  try {
    isSigningIn = true;
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error('Gagal mendapatkan access token Google Drive dari Firebase Auth');
    }
    cachedAccessToken = credential.accessToken;
    currentUser = result.user;
    notifyListeners();

    // Sync token to server so Android WebView APK can also upload without popup issues
    try {
      fetch('/api/gdrive/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: cachedAccessToken, email: result.user.email })
      }).catch(() => {});
    } catch (e) {}

    return { user: result.user, accessToken: cachedAccessToken };
  } catch (error: any) {
    console.error('Google Drive sign-in error:', error);
    throw error;
  } finally {
    isSigningIn = false;
  }
}

export async function signOutGoogleDrive(): Promise<void> {
  await signOut(auth);
  cachedAccessToken = null;
  currentUser = null;
  notifyListeners();
  try {
    fetch('/api/gdrive/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: null })
    }).catch(() => {});
  } catch (e) {}
}

export function isGoogleDriveConnected(): boolean {
  return !!cachedAccessToken;
}

export function getGoogleDriveUser(): User | null {
  return currentUser;
}

export function getGoogleDriveAccessToken(): string | null {
  return cachedAccessToken;
}

export function setGoogleDriveAccessToken(token: string): void {
  cachedAccessToken = token;
  notifyListeners();
}

export function getTargetFolderId(): string {
  if (typeof window !== 'undefined') {
    const saved = localStorage.getItem('ib_gdrive_folder_id');
    if (saved && saved.trim()) return saved.trim();
  }
  return DEFAULT_GDRIVE_FOLDER_ID;
}

export function setTargetFolderId(folderId: string): void {
  if (typeof window !== 'undefined') {
    localStorage.setItem('ib_gdrive_folder_id', folderId.trim());
  }
}

/**
 * Creates a PDF Blob from an HTML string using html2pdf
 */
export async function createPdfBlobFromHtml(htmlContent: string, filename: string, isNota = true): Promise<Blob> {
  if (typeof window === 'undefined') {
    throw new Error('createPdfBlobFromHtml hanya dapat dijalankan di browser');
  }
  const container = document.createElement('div');
  container.style.position = 'fixed';
  container.style.top = '-99999px';
  container.style.left = '-99999px';
  container.style.width = isNota ? '794px' : '595px';
  container.style.backgroundColor = '#ffffff';
  container.innerHTML = htmlContent;
  document.body.appendChild(container);

  try {
    const html2pdf = (window as any).html2pdf;
    if (typeof html2pdf !== 'function') {
      throw new Error('Pustaka html2pdf belum tersedia di browser.');
    }
    const opt = {
      margin: [4, 4, 4, 4],
      filename: filename,
      image: { type: 'jpeg', quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true, logging: false },
      jsPDF: { unit: 'mm', format: isNota ? 'a4' : 'a5', orientation: 'portrait' }
    };
    const worker = html2pdf().set(opt).from(container);
    const blob: Blob = await worker.outputPdf('blob');
    return blob;
  } finally {
    if (container.parentNode) {
      container.parentNode.removeChild(container);
    }
  }
}

/**
 * Upload a PDF Blob or Base64 string to the user's Google Drive folder
 * and set permissions to anyone with link (reader) so WhatsApp recipients can download it.
 */
export async function uploadPdfToGoogleDrive(params: {
  filename: string;
  blob?: Blob;
  base64Pdf?: string;
  folderId?: string;
}): Promise<{
  fileId: string;
  viewUrl: string;
  downloadUrl: string;
  webContentLink?: string;
}> {
  let token = cachedAccessToken;
  if (!token) {
    token = await syncTokenWithServer();
  }

  let fileBlob: Blob;
  if (params.blob) {
    fileBlob = params.blob;
  } else if (params.base64Pdf) {
    const cleanBase64 = params.base64Pdf.replace(/^data:application\/pdf;base64,/, '');
    const byteCharacters = atob(cleanBase64);
    const byteNumbers = new Array(byteCharacters.length);
    for (let i = 0; i < byteCharacters.length; i++) {
      byteNumbers[i] = byteCharacters.charCodeAt(i);
    }
    const byteArray = new Uint8Array(byteNumbers);
    fileBlob = new Blob([byteArray], { type: 'application/pdf' });
  } else {
    throw new Error('Data file PDF tidak ditemukan untuk diunggah');
  }

  const folderId = params.folderId || getTargetFolderId();

  // Helper function to upload via server proxy (essential for Android WebView APK)
  const tryServerProxyUpload = async (): Promise<{
    fileId: string;
    viewUrl: string;
    downloadUrl: string;
    webContentLink?: string;
  }> => {
    let base64Str = '';
    if (params.base64Pdf) {
      base64Str = params.base64Pdf.replace(/^data:application\/pdf;base64,/, '');
    } else {
      base64Str = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const res = reader.result as string;
          resolve(res.replace(/^data:[^;]+;base64,/, ''));
        };
        reader.onerror = reject;
        reader.readAsDataURL(fileBlob);
      });
    }

    const proxyResp = await fetch('/api/gdrive/upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {})
      },
      body: JSON.stringify({
        filename: params.filename,
        base64Pdf: base64Str,
        folderId: folderId
      })
    });

    if (!proxyResp.ok) {
      const errText = await proxyResp.text();
      throw new Error(`Upload server proxy gagal (${proxyResp.status}): ${errText}`);
    }

    const data = await proxyResp.json();
    if (!data.success) {
      throw new Error(data.message || 'Gagal upload via server proxy');
    }

    return {
      fileId: data.fileId,
      viewUrl: data.viewUrl,
      downloadUrl: data.downloadUrl,
      webContentLink: data.webContentLink || data.downloadUrl
    };
  };

  // If token is completely absent on client, try server proxy immediately
  if (!token) {
    try {
      return await tryServerProxyUpload();
    } catch (proxyErr: any) {
      throw new Error('Belum terhubung ke Google Drive. Silakan hubungkan akun Google terlebih dahulu.');
    }
  }

  try {
    // 1. Prepare Multipart Upload metadata
    const metadata: any = {
      name: params.filename,
      mimeType: 'application/pdf'
    };
    if (folderId) {
      metadata.parents = [folderId];
    }

    const boundary = '-------314159265358979323846';
    const delimiter = `\r\n--${boundary}\r\n`;
    const closeDelimiter = `\r\n--${boundary}--`;

    const metadataPart = `${delimiter}Content-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}`;
    const fileHeaderPart = `\r\n--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`;

    const fileReader = new FileReader();
    const fileArrayBuffer = await new Promise<ArrayBuffer>((resolve, reject) => {
      fileReader.onload = () => resolve(fileReader.result as ArrayBuffer);
      fileReader.onerror = reject;
      fileReader.readAsArrayBuffer(fileBlob);
    });

    const bodyBlob = new Blob([
      metadataPart,
      fileHeaderPart,
      new Uint8Array(fileArrayBuffer),
      closeDelimiter
    ], { type: `multipart/related; boundary=${boundary}` });

    // 2. Upload file to Drive (with fallback if folder permissions fail)
    let uploadResponse = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink,webContentLink', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': `multipart/related; boundary=${boundary}`
      },
      body: bodyBlob
    });

    if (!uploadResponse.ok && folderId && (uploadResponse.status === 404 || uploadResponse.status === 403)) {
      console.warn(`Drive upload with folder ${folderId} failed (${uploadResponse.status}). Retrying to root Drive...`);
      const fallbackMetadata = {
        name: params.filename,
        mimeType: 'application/pdf'
      };
      const fallbackMetadataPart = `${delimiter}Content-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(fallbackMetadata)}`;
      const fallbackBodyBlob = new Blob([
        fallbackMetadataPart,
        fileHeaderPart,
        new Uint8Array(fileArrayBuffer),
        closeDelimiter
      ], { type: `multipart/related; boundary=${boundary}` });

      uploadResponse = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink,webContentLink', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': `multipart/related; boundary=${boundary}`
        },
        body: fallbackBodyBlob
      });
    }

    if (!uploadResponse.ok) {
      console.warn(`Direct client Drive upload failed (${uploadResponse.status}). Falling back to server proxy upload...`);
      return await tryServerProxyUpload();
    }

    const uploadedFile = await uploadResponse.json();
    const fileId = uploadedFile.id;

    // 3. Set permission so anyone with link can view and download
    try {
      await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          role: 'reader',
          type: 'anyone'
        })
      });
    } catch (permErr) {
      console.warn('Could not set public permission on Drive file:', permErr);
    }

    let viewUrl = uploadedFile.webViewLink || `https://drive.google.com/file/d/${fileId}/view?usp=sharing`;
    let downloadUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;

    try {
      const metaResp = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,webViewLink,webContentLink`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (metaResp.ok) {
        const meta = await metaResp.json();
        if (meta.webViewLink) viewUrl = meta.webViewLink;
        if (meta.webContentLink) downloadUrl = meta.webContentLink;
      }
    } catch (e) {
      console.warn('Could not fetch file links from Drive:', e);
    }

    return {
      fileId,
      viewUrl,
      downloadUrl,
      webContentLink: downloadUrl
    };
  } catch (err: any) {
    console.warn('Direct upload error, trying server proxy upload:', err);
    return await tryServerProxyUpload();
  }
}

// Expose globally for app.js integration
if (typeof window !== 'undefined') {
  (window as any).GoogleDriveIntegration = {
    SCOPES,
    DEFAULT_GDRIVE_FOLDER_ID,
    signInGoogleDrive,
    signOutGoogleDrive,
    isGoogleDriveConnected,
    getGoogleDriveUser,
    getGoogleDriveAccessToken,
    getTargetFolderId,
    setTargetFolderId,
    createPdfBlobFromHtml,
    uploadPdfToGoogleDrive,
    onGoogleAuthStateChange
  };
}
