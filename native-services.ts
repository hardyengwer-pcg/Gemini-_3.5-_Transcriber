import { google } from 'googleapis';
import { GoogleGenAI } from '@google/genai';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';
import 'dotenv/config';

const execFileAsync = promisify(execFile);
const configuredFfmpegPath = typeof ffmpegPath === 'string' ? ffmpegPath : '';
const resolvedFfmpegPath = configuredFfmpegPath && fs.existsSync(configuredFfmpegPath)
  ? configuredFfmpegPath
  : path.join(process.cwd(), 'node_modules', 'ffmpeg-static', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');

const apiKey = process.env.GEMINI_API_KEY || '';
const clientId = process.env.GOOGLE_CLIENT_ID || '';
const clientSecret = process.env.GOOGLE_CLIENT_SECRET || '';
const refreshToken = process.env.GOOGLE_REFRESH_TOKEN || '';

function getAuth() {
  const auth = new google.auth.OAuth2(clientId, clientSecret);
  if (refreshToken) auth.setCredentials({ refresh_token: refreshToken });
  return auth;
}

async function recordingsFolderId(drive: any): Promise<string> {
  const found = await drive.files.list({
    q: "name = 'Meet Recordings' and mimeType = 'application/vnd.google-apps.folder' and trashed = false and 'root' in parents",
    fields: 'files(id,name,parents)',
    spaces: 'drive',
  });
  if (found.data.files?.[0]?.id) {
    console.log(`[Drive] Verwende My-Drive-Ordner Meet Recordings: ${found.data.files[0].id}`);
    return found.data.files[0].id;
  }
  const created = await drive.files.create({
    requestBody: { name: 'Meet Recordings', mimeType: 'application/vnd.google-apps.folder' },
    fields: 'id',
  });
  console.log(`[Drive] My-Drive-Ordner Meet Recordings erstellt: ${created.data.id}`);
  return created.data.id;
}

function protocolPrompt(language: string, mode: 'protocol' | 'direct'): string {
  const languageHint = language === 'de' ? 'Deutsch.' : language === 'en' ? 'English.' : 'Deutsch oder Englisch automatisch erkennen.';
  if (mode === 'direct') return `Transkribiere ausschließlich die tatsächlich gesprochenen Wörter. Keine Erklärungen, keine Überschriften, keine Metadaten. Sprache: ${languageHint}`;
  return `Erstelle ein vollständiges Gesprächsprotokoll als Markdown und danach ein wortgetreues Transkript. Sprache: ${languageHint}

# Gespraechsprotokoll: [Titel]

- **Datum und Uhrzeit:** [automatisch]
- **Sprache:** [erkannt]

## Teilnehmende
- [Sprecher]

## Notizen und Agenda
- [Kernpunkte und Entscheidungen, sprachlich bereinigt]

## Aktionspunkte
- [ ] **[Verantwortliche Person]:** [Aufgabe und Frist, sprachlich bereinigt]

## Wortgetreues Transkript
[Exakter Wortlaut mit Sprecherwechseln]

Regeln für die bereinigten Bereiche:
- Entferne Füllwörter und Sprechpausen wie "äh", "öh", "hm", "also" und sinnlose Wiederholungen.
- Korrigiere offensichtliche Versprecher nur, wenn die beabsichtigte Aussage eindeutig ist.
- Erhalte Namen, Fachbegriffe, Zahlen, Entscheidungen und Unsicherheiten exakt.
- Erfinde keine Inhalte und ändere keine Verantwortlichkeiten.

Regeln für den Verbatim-Bereich:
- Bewahre dort den vollständigen Originalwortlaut einschließlich Füllwörtern, Wiederholungen und Versprechern.
- Keine Zusammenfassung und keine sprachliche Bereinigung im Verbatim-Bereich.
- Keine Emojis.`;
}

function extractTranscriptionText(response: any): string {
  if (response?.text && typeof response.text === 'string' && response.text.trim()) {
    return response.text.trim();
  }

  for (const candidate of response?.candidates || []) {
    for (const part of candidate.content?.parts || []) {
      if (part.text?.trim()) return part.text.trim();
      if (part.audioTranscription?.text?.trim()) return part.audioTranscription.text.trim();
      if (part.transcript?.text?.trim()) return part.transcript.text.trim();
    }
  }
  return '';
}

export async function transcribeAudio(input: {
  audioBase64: string;
  mimeType: string;
  language: string;
  mode: 'protocol' | 'direct';
}) {
  if (!apiKey) throw new Error('GEMINI_API_KEY fehlt in .env');
  const ai = new GoogleGenAI({ apiKey });
  const buffer = Buffer.from(input.audioBase64, 'base64');
  const prompt = protocolPrompt(input.language, input.mode);
  let response: any;
  let uploadedName: string | undefined;

  if (buffer.length <= 18 * 1024 * 1024) {
    response = await ai.models.generateContent({
      model: 'gemini-3.5-transcribe',
      contents: [{ role: 'user', parts: [
        { inlineData: { mimeType: input.mimeType, data: input.audioBase64 } },
        { text: prompt },
      ] }],
      config: { maxOutputTokens: 65536, temperature: 0 },
    });
  } else {
    const tempPath = path.join(process.cwd(), `transcriber-${Date.now()}.webm`);
    fs.writeFileSync(tempPath, buffer);
    try {
      let uploaded: any = await ai.files.upload({ file: tempPath, mimeType: input.mimeType } as any);
      uploadedName = uploaded.name;
      let attempts = 0;
      while (uploaded.state === 'PROCESSING' && attempts < 30) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        if (uploaded.name) uploaded = await ai.files.get({ name: uploaded.name });
        attempts++;
      }
      response = await ai.models.generateContent({
        model: 'gemini-3.5-transcribe',
        contents: [{ role: 'user', parts: [
          { fileData: { fileUri: uploaded.uri, mimeType: uploaded.mimeType || input.mimeType } },
          { text: prompt },
        ] }],
        config: { maxOutputTokens: 65536, temperature: 0 },
      });
    } finally {
      if (uploadedName) {
        try { await ai.files.delete({ name: uploadedName }); } catch {}
      }
      try { fs.unlinkSync(tempPath); } catch {}
    }
  }
  const transcription = extractTranscriptionText(response);
  if (!transcription) throw new Error('Gemini hat keinen Transkripttext zurückgegeben.');
  return { transcription, modelUsed: 'gemini-3.5-transcribe' };
}

async function transcribeSingleAudioFile(filePath: string, mimeType: string, language: string, mode: 'protocol' | 'direct') {
  if (!apiKey) throw new Error('GEMINI_API_KEY fehlt in .env');
  const ai = new GoogleGenAI({ apiKey });
  const prompt = protocolPrompt(language, mode);
  let uploaded: any;

  try {
    console.log(`[Native Transcribe] Upload starte: ${filePath}`);
    uploaded = await ai.files.upload({ file: filePath, mimeType } as any);
    console.log(`[Native Transcribe] Upload abgeschlossen: ${uploaded.name || uploaded.uri}, Status: ${uploaded.state || 'unknown'}`);
    let attempts = 0;
    // Long meeting recordings can take several minutes before Files API activation.
    while (uploaded.state === 'PROCESSING' && attempts < 300) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      if (uploaded.name) {
        uploaded = await ai.files.get({ name: uploaded.name });
        console.log(`[Native Transcribe] File-Status: ${uploaded.state || 'unknown'}`);
      }
      attempts++;
    }
    if (uploaded.state === 'PROCESSING') {
      throw new Error('Die Audio-Datei wurde innerhalb von 10 Minuten nicht für die Transkription aktiviert.');
    }
    if (uploaded.state && uploaded.state !== 'ACTIVE') {
      const detail = uploaded.error?.message || uploaded.state;
      throw new Error(`Audio-Datei konnte nicht aktiviert werden: ${detail}`);
    }

    const response = await ai.models.generateContent({
      model: 'gemini-3.5-transcribe',
      contents: [{ role: 'user', parts: [
        { fileData: { fileUri: uploaded.uri, mimeType: uploaded.mimeType || mimeType } },
        { text: prompt },
      ] }],
      config: { maxOutputTokens: 65536, temperature: 0 },
    });
    const transcription = extractTranscriptionText(response);
    if (!transcription) throw new Error('Gemini hat keinen Transkripttext zurückgegeben.');
    return { transcription, modelUsed: 'gemini-3.5-transcribe' };
  } finally {
    if (uploaded?.name) {
      try { await ai.files.delete({ name: uploaded.name }); } catch {}
    }
  }
}

export async function transcribeAudioFile(filePath: string, mimeType: string, language: string, mode: 'protocol' | 'direct') {
  if (!fs.existsSync(resolvedFfmpegPath)) throw new Error(`FFmpeg ist für lange Aufnahmen nicht verfügbar: ${resolvedFfmpegPath}`);

  const segmentPrefix = path.join(path.dirname(filePath), `${path.basename(filePath, path.extname(filePath))}-segment-`);
  const segmentPattern = `${segmentPrefix}%03d.mp3`;
  const segmentFiles: string[] = [];
  let completed = false;

  try {
    await execFileAsync(resolvedFfmpegPath, [
      '-y', '-i', filePath, '-map', '0:a:0', '-c:a', 'libmp3lame', '-b:a', '64k',
      '-f', 'segment', '-segment_time', '600', '-reset_timestamps', '1', segmentPattern,
    ], { windowsHide: true });

    for (const name of fs.readdirSync(path.dirname(filePath))) {
      if (name.startsWith(path.basename(segmentPrefix)) && name.endsWith('.mp3')) {
        segmentFiles.push(path.join(path.dirname(filePath), name));
      }
    }
    segmentFiles.sort();
    if (segmentFiles.length === 0) throw new Error('FFmpeg konnte keine Audiosegmente erzeugen.');

    console.log(`[Native Transcribe] ${segmentFiles.length} Audiosegment(e) zur Verarbeitung bereit.`);
    const transcriptions: string[] = [];
    for (let index = 0; index < segmentFiles.length; index++) {
      const segment = segmentFiles[index];
      let lastError: unknown;
      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          console.log(`[Native Transcribe] Segment ${index + 1}/${segmentFiles.length}, Versuch ${attempt}/5`);
          const result = await transcribeSingleAudioFile(segment, 'audio/mpeg', language, mode);
          transcriptions.push(result.transcription);
          lastError = undefined;
          break;
        } catch (error: any) {
          lastError = error;
          const errStr = error?.message || JSON.stringify(error || {});
          console.warn(`[Native Transcribe] Segment ${index + 1} fehlgeschlagen (Versuch ${attempt}/5):`, error);
          if (attempt < 5) {
            let waitTimeMs = attempt * 5000;
            // Wenn 429 Quota Exceeded (z. B. Free Tier RPM/TPM Limit), Wartezeit dynamisch anpassen
            const retryMatch = errStr.match(/retry in ([0-9.]+)s/i) || errStr.match(/retryDelay":"([0-9]+)s"/i);
            if (retryMatch) {
              waitTimeMs = (Math.ceil(parseFloat(retryMatch[1])) + 5) * 1000;
              console.log(`[Native Transcribe] 429 Rate-Limit erkannt. Warte ${waitTimeMs / 1000}s vor nächstem Versuch...`);
            } else if (errStr.includes('429') || errStr.includes('RESOURCE_EXHAUSTED')) {
              waitTimeMs = 45000; // Standard 45s für Gemini Minute-Window
              console.log(`[Native Transcribe] 429 Quota erreicht. Warte 45s für Token-Window-Reset...`);
            }
            await new Promise(resolve => setTimeout(resolve, waitTimeMs));
          }
        }
      }
      if (lastError) {
        throw new Error(`Segment ${index + 1}/${segmentFiles.length} konnte nach 5 Versuchen nicht transkribiert werden: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
      }
    }
    completed = true;
    return { transcription: transcriptions.join('\n\n'), modelUsed: 'gemini-3.5-transcribe' };
  } finally {
    if (completed) {
      for (const segment of segmentFiles) {
        try { fs.unlinkSync(segment); } catch {}
      }
    }
  }
}

export async function exportMarkdownToDrive(title: string, content: string) {
  const drive = google.drive({ version: 'v3', auth: getAuth() });
  const folderId = await recordingsFolderId(drive);
  const file = await drive.files.create({
    requestBody: { name: title.endsWith('.md') ? title : `${title}.md`, parents: [folderId], mimeType: 'text/markdown' },
    media: { mimeType: 'text/markdown', body: content },
    fields: 'id,name,webViewLink',
  });
  console.log(`[Drive] Markdown gespeichert: ${file.data.name} (${file.data.id})`);
  return { fileId: file.data.id, fileName: file.data.name, link: file.data.webViewLink, folder: 'Meet Recordings' };
}
