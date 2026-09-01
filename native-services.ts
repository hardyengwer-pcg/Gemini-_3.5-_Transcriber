import { google } from 'googleapis';
import { GoogleGenAI } from '@google/genai';
import fs from 'node:fs';
import path from 'node:path';
import 'dotenv/config';

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
    q: "name = 'Meet Recordings' and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
    fields: 'files(id)',
    spaces: 'drive',
  });
  if (found.data.files?.[0]?.id) return found.data.files[0].id;
  const created = await drive.files.create({
    requestBody: { name: 'Meet Recordings', mimeType: 'application/vnd.google-apps.folder' },
    fields: 'id',
  });
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

export async function transcribeAudioFile(filePath: string, mimeType: string, language: string, mode: 'protocol' | 'direct') {
  if (!apiKey) throw new Error('GEMINI_API_KEY fehlt in .env');
  const ai = new GoogleGenAI({ apiKey });
  const prompt = protocolPrompt(language, mode);
  let uploaded: any;

  try {
    uploaded = await ai.files.upload({ file: filePath, mimeType } as any);
    let attempts = 0;
    while (uploaded.state === 'PROCESSING' && attempts < 60) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      if (uploaded.name) uploaded = await ai.files.get({ name: uploaded.name });
      attempts++;
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

export async function exportMarkdownToDrive(title: string, content: string) {
  const drive = google.drive({ version: 'v3', auth: getAuth() });
  const folderId = await recordingsFolderId(drive);
  const file = await drive.files.create({
    requestBody: { name: title.endsWith('.md') ? title : `${title}.md`, parents: [folderId], mimeType: 'text/markdown' },
    media: { mimeType: 'text/markdown', body: content },
    fields: 'id,name,webViewLink',
  });
  return { fileId: file.data.id, fileName: file.data.name, link: file.data.webViewLink, folder: 'Meet Recordings' };
}
