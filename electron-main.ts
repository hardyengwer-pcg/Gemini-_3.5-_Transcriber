import { app, BrowserWindow, ipcMain, desktopCapturer, clipboard, globalShortcut } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { exec, execFileSync } from 'node:child_process';
import WebSocket from 'ws';
import 'dotenv/config';
import { exportMarkdownToDrive, transcribeAudio, transcribeAudioFile } from './native-services.ts';

let mainWindow: BrowserWindow | null = null;
let dictationTargetHwnd = '';
let liveGeminiSocket: WebSocket | null = null;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 780,
    minWidth: 360,
    minHeight: 180,
    backgroundColor: '#09090b',
    title: 'Google Transcriber',
    frame: true, // Standard OS-Titelleiste zum einfachen Verschieben und Minimieren
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'electron-preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
  if (isDev) {
    mainWindow.loadURL('http://localhost:3005');
  } else {
    mainWindow.loadFile(path.join(__dirname, 'dist', 'index.html'));
  }

  // Globaler Hotkey (Strg + F9 oder F9): Startet/Stoppt Diktat aus JEDEM beliebigen Fenster
  globalShortcut.register('F9', () => {
    if (mainWindow) {
      try {
        // F9 wird global ausgelöst, während das eigentliche Ziel noch Vordergrund ist.
        const hwndScript = path.join(app.getPath('temp'), 'google-transcriber-foreground.ps1');
        fs.writeFileSync(hwndScript, `
$c = @'
using System;
using System.Runtime.InteropServices;
public static class ForegroundWindow {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
}
'@
Add-Type -TypeDefinition $c
[Console]::Write(([ForegroundWindow]::GetForegroundWindow()).ToInt64())
`, 'utf8');
        dictationTargetHwnd = execFileSync('powershell.exe', [
          '-NoProfile',
          '-ExecutionPolicy', 'Bypass',
          '-File', hwndScript,
        ], { encoding: 'utf8', windowsHide: true }).trim();
        console.log(`[Dictation Target] HWND gespeichert: ${dictationTargetHwnd}`);
      } catch (e) {
        console.warn('[Dictation Target] Vordergrundfenster konnte nicht gelesen werden:', e);
        dictationTargetHwnd = '';
      }
      mainWindow.webContents.send('toggle-recording-hotkey');
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// IPC Handlers für Mini-Modus
ipcMain.handle('set-compact-mode', async (_, compact: boolean) => {
  if (!mainWindow) return;
  if (compact) {
    mainWindow.setAlwaysOnTop(true);
    mainWindow.setSize(380, 220);
  } else {
    mainWindow.setAlwaysOnTop(false);
    mainWindow.setSize(960, 780);
  }
});

ipcMain.handle('live-start', async () => {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY fehlt in .env');
  if (liveGeminiSocket?.readyState === WebSocket.OPEN) return true;

  await new Promise<void>((resolve, reject) => {
    const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;
    const socket = new WebSocket(url);
    liveGeminiSocket = socket;

    socket.once('open', () => {
      socket.send(JSON.stringify({
        setup: {
          model: 'models/gemini-3.5-transcribe-live',
          generationConfig: { responseModalities: ['TEXT'], temperature: 0.0 },
          inputAudioTranscription: {},
          realtimeInputConfig: {
            automaticActivityDetection: {
              prefix_padding_ms: 80,
              silence_duration_ms: 350,
            },
          },
        },
      }));
      resolve();
    });
    socket.once('error', reject);
    socket.on('message', (data) => {
      try {
        const parsed = JSON.parse(data.toString());
        const text = parsed.serverContent?.inputTranscription?.text;
        if (text && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('live-text', text);
        }
        if (parsed.error && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('live-error', JSON.stringify(parsed.error));
        }
      } catch (error) {
        console.warn('[Native Live] Antwort konnte nicht gelesen werden:', error);
      }
    });
    socket.on('close', (code, reason) => {
      console.log(`[Native Live] Gemini geschlossen (${code}): ${reason.toString()}`);
      liveGeminiSocket = null;
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('live-closed', code);
    });
  });
  return true;
});

ipcMain.handle('live-audio', async (_, data: string) => {
  if (typeof data !== 'string' || data.length > 512000) return false;
  if (!liveGeminiSocket || liveGeminiSocket.readyState !== WebSocket.OPEN) return false;
  liveGeminiSocket.send(JSON.stringify({
    realtimeInput: { mediaChunks: [{ mimeType: 'audio/pcm;rate=16000', data }] },
  }));
  return true;
});

ipcMain.handle('live-stop', async () => {
  if (liveGeminiSocket) {
    liveGeminiSocket.close(1000, 'user stopped live dictation');
    liveGeminiSocket = null;
  }
  return true;
});

ipcMain.handle('transcribe-audio', async (_, input) => {
  if (!input || typeof input.audioBase64 !== 'string' || input.audioBase64.length > 200 * 1024 * 1024) {
    throw new Error('Ungültige oder zu große Audiodaten.');
  }
  const mode = input.mode === 'direct' ? 'direct' : 'protocol';
  const result = await transcribeAudio({
    audioBase64: input.audioBase64,
    mimeType: String(input.mimeType || 'audio/webm'),
    language: String(input.language || 'auto'),
    mode,
  });
  if (mode === 'protocol') {
    const now = new Date();
    const title = `Transkript_${now.toISOString().slice(0, 10)}_${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}`;
    try {
      (result as any).driveExport = await exportMarkdownToDrive(title, result.transcription);
    } catch (error) {
      console.warn('[Native Drive Export] übersprungen:', error);
    }
  }
  return result;
});

ipcMain.handle('export-drive', async (_, input) => {
  if (!input || typeof input.content !== 'string' || input.content.length > 20 * 1024 * 1024) {
    throw new Error('Ungültiger oder zu großer Markdown-Inhalt.');
  }
  return exportMarkdownToDrive(String(input.title || `Transkript_${Date.now()}`), input.content);
});

let recordingFilePath = '';

ipcMain.handle('recording-file-start', async () => {
  recordingFilePath = path.join(app.getPath('temp'), `google-transcriber-${Date.now()}.webm`);
  fs.writeFileSync(recordingFilePath, Buffer.alloc(0));
  return true;
});

ipcMain.handle('recording-file-append', async (_, chunk: ArrayBuffer) => {
  if (!recordingFilePath || !(chunk instanceof ArrayBuffer)) return false;
  fs.appendFileSync(recordingFilePath, Buffer.from(chunk));
  return true;
});

ipcMain.handle('recording-file-finish', async (_, input) => {
  if (!recordingFilePath) throw new Error('Keine temporäre Aufnahme vorhanden.');
  const filePath = recordingFilePath;
  recordingFilePath = '';
  try {
    const mimeType = String(input?.mimeType || 'audio/webm');
    const language = String(input?.language || 'auto');
    const fileSize = fs.statSync(filePath).size;
    if (fileSize === 0) throw new Error('Die Aufnahme enthält keine Audiodaten.');
    console.log(`[Protocol] Aufnahme beendet: ${(fileSize / 1024 / 1024).toFixed(1)} MB`);
    // Kurze Aufnahmen inline verarbeiten; große Meetings über Files API.
    // Das vermeidet Files-API-Probleme mit sehr kleinen WebM-Containern.
    const result = fileSize <= 12 * 1024 * 1024
      ? await transcribeAudio({
          audioBase64: fs.readFileSync(filePath).toString('base64'),
          mimeType,
          language,
          mode: 'protocol',
        })
      : await transcribeAudioFile(filePath, mimeType, language, 'protocol');
    console.log(`[Protocol] Transkription fertig mit ${result.modelUsed}`);
    const now = new Date();
    result.driveExport = await exportMarkdownToDrive(`Transkript_${now.toISOString().slice(0, 10)}_${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}`, result.transcription);
    console.log(`[Protocol] Drive-Export fertig: ${result.driveExport.fileName}`);
    return result;
  } finally {
    try { fs.unlinkSync(filePath); } catch {}
  }
});

// IPC Handler: Direktes Diktieren an die Cursor-Position im aktiven Fremdfenster
ipcMain.handle('type-text-at-cursor', async (_, text: string) => {
  if (!text || typeof text !== 'string') return false;
  
  try {
    // Clipboard als Fallback beibehalten, aber nicht mehr als primären Transport nutzen.
    clipboard.writeText(text);
    console.log(`[Type at Cursor] Native SendInput für ${text.length} Zeichen`);

    // Vollständiges Segment atomisch einfügen. Zeichen-für-Zeichen SendInput
    // verliert bei langen Unicode-Sequenzen in manchen Editoren Zeichen.
    if (process.platform === 'win32') {
      const psFilePath = path.join(app.getPath('temp'), 'google-transcriber-send-input.ps1');
      const psContent = `
$c = @'
using System;
using System.Runtime.InteropServices;
public class KeySender {
    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT {
        public UInt32 type;
        public UInt32 padding;
        public KEYBDINPUT ki;
        public UInt64 unionPadding;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT {
        public UInt16 wVk;
        public UInt16 wScan;
        public UInt32 dwFlags;
        public UInt32 time;
        public IntPtr dwExtraInfo;
    }
    [DllImport("user32.dll", SetLastError = true)]
    public static extern UInt32 SendInput(UInt32 nInputs, INPUT[] pInputs, Int32 cbSize);
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    public static void SendCtrlV() {
        var inputs = new INPUT[4];
        inputs[0] = new INPUT { type = 1, padding = 0, ki = new KEYBDINPUT { wVk = 0x11, dwFlags = 0, dwExtraInfo = IntPtr.Zero }, unionPadding = 0 };
        inputs[1] = new INPUT { type = 1, padding = 0, ki = new KEYBDINPUT { wVk = 0x56, dwFlags = 0, dwExtraInfo = IntPtr.Zero }, unionPadding = 0 };
        inputs[2] = new INPUT { type = 1, padding = 0, ki = new KEYBDINPUT { wVk = 0x56, dwFlags = 0x0002, dwExtraInfo = IntPtr.Zero }, unionPadding = 0 };
        inputs[3] = new INPUT { type = 1, padding = 0, ki = new KEYBDINPUT { wVk = 0x11, dwFlags = 0x0002, dwExtraInfo = IntPtr.Zero }, unionPadding = 0 };
        var sent = SendInput((UInt32)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
        if (sent != inputs.Length) {
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "SendInput konnte Ctrl+V nicht senden");
        }
    }
}
'@
Add-Type -TypeDefinition $c -ErrorAction Stop
${dictationTargetHwnd ? `[KeySender]::SetForegroundWindow([IntPtr]${dictationTargetHwnd})` : ''}
Start-Sleep -Milliseconds 120
[KeySender]::SendCtrlV()
`;
      fs.writeFileSync(psFilePath, psContent, 'utf8');

      // Synchron ausführen: Live-Segmente dürfen sich nicht überlappen.
      try {
        execFileSync('powershell.exe', [
          '-WindowStyle', 'Hidden',
          '-NoProfile',
          '-ExecutionPolicy', 'Bypass',
          '-File', psFilePath,
        ], { windowsHide: true, stdio: 'pipe' });
      } catch (err) {
        console.warn('[Type at Cursor] SendInput error:', err);
      }
    }
    return true;
  } catch (e) {
    console.warn('Type at cursor error:', e);
    return false;
  }
});

// IPC Handler um Desktop / Audio Quellen für System-Loopback bereitzustellen
ipcMain.handle('get-desktop-sources', async () => {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      fetchWindowIcons: false,
    });
    return sources.map((s) => ({
      id: s.id,
      name: s.name,
    }));
  } catch (e: any) {
    console.warn('Desktop Capturer error:', e);
    return [];
  }
});

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
