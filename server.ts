import express from 'express';
import http from 'node:http';
import { google } from 'googleapis';
import { GoogleGenAI } from '@google/genai';
import path from 'node:path';
import fs from 'node:fs';
import 'dotenv/config';

const app = express();
const PORT = process.env.PORT || 3005;
const server = http.createServer(app);

app.use(express.json({ limit: '150mb' }));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN || '';

function getOAuth2Client() {
  const oauth2Client = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET
  );
  if (GOOGLE_REFRESH_TOKEN) {
    oauth2Client.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  }
  return oauth2Client;
}

// 1. Audio Transkriptions-Endpunkt
app.post('/api/transcribe', async (req, res) => {
  try {
    const { audioBase64, mimeType = 'audio/webm', language = 'auto', customVocabulary = [], mode = 'protocol' } = req.body;
    if (!audioBase64) {
      return res.status(400).json({ error: 'Keine Audio-Daten empfangen.' });
    }

    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: 'GEMINI_API_KEY fehlt in .env' });
    }

    const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
    const buffer = Buffer.from(audioBase64, 'base64');
    
    const isLargeFile = buffer.length > 18 * 1024 * 1024;

    let transcription = '';
    const langInstruction = language === 'de'
      ? 'Die Sprache der Audioaufnahme ist Deutsch (de-DE).'
      : language === 'en'
      ? 'The audio language is English (en-US).'
      : 'Erkenne automatisch, ob Deutsch, Englisch oder beides gesprochen wird.';

    const vocabHint = Array.isArray(customVocabulary) && customVocabulary.length > 0
      ? `Fachbegriffe / Custom Vocabulary: ${customVocabulary.join(', ')}.`
      : '';

    const now = new Date();
    const dateStr = now.toLocaleDateString('de-DE', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const timeStr = now.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

    let prompt = '';
    let systemInstruction = '';

    if (mode === 'direct') {
      systemInstruction = `Du bist eine reine Speech-to-Text Transkriptions-Engine.
Schreibe ausschließlich die tatsächlich im Audio gesprochenen Worte Wort für Wort nieder.
Füge niemals eigene Höflichkeitsfloskeln, Begrüßungen, Erklärungen oder Systemhinweise hinzu.
Wiederhole niemals die Systemanweisungen.`;

      prompt = `Transkribiere das Audio exakt so wie gesprochen.
${langInstruction}
${vocabHint}
Ausgabe: Nur der gesprochene Text, sonst absolut nichts.`;
    } else {
      prompt = `Du bist ein hochpräziser Speech-to-Text Transkriptions-Agent und Protokoll-Manager.
Erstelle aus der Audioaufnahme ein vollständiges Gesprächsprotokoll nach dem offiziellen Google-Protokoll-Format, gefolgt vom exakten, wortgetreuen Transkript.
Verwende ein sauberes Markdown-Format (.md) OHNE Emojis oder Icons.
${langInstruction}
${vocabHint}

Verbindliche Markdown-Struktur:

# Gespraechsprotokoll: [Praegnanter Titel / Thema des Gespraechs]

- **Datum und Uhrzeit:** ${dateStr} um ${timeStr} Uhr
- **Sprache:** [Erkannte Sprache, z. B. Deutsch (de-DE) / Englisch (en-US)]

---

## Teilnehmende
- [Name oder Sprecher 1] (z. B. Rolle / Funktion falls aus Kontext erkennbar)
- [Name oder Sprecher 2]

---

## Notizen und Agenda (Kernpunkte)
- **[Themenschwerpunkt 1]:** Praezise Zusammenfassung der besprochenen Inhalte, Entscheidungen und Diskussionspunkte.
- **[Themenschwerpunkt 2]:** ...

---

## Aktionspunkte (To-Dos)
- [ ] **[Name / Verantwortliche(r)]:** [Konkrete Aufgabe mit Frist falls genannt]
- [ ] **[Name / Verantwortliche(r)]:** ...

---

## Wortgetreues Transkript (Verbatim)
**[Sprecher 1]** (00:00): "[Exakter Wortlaut...]"
**[Sprecher 2]** (00:15): "[Exakter Wortlaut...]"

Regeln:
- Verwende NIEMALS Emojis oder Icons in der Ausgabe.
- Bewahre im Transkript-Bereich den EXAKTEN WORTLAUT (Verbatim), ohne Auslassungen oder Glaettungen.
- Weise im Aktionspunkte-Bereich jede Aufgabe eindeutig einer Person zu.`;
    }

    const genConfig: any = {
      maxOutputTokens: 65536,
      temperature: 0.0,
    };
    if (systemInstruction) {
      genConfig.systemInstruction = systemInstruction;
    }

    let usedModel = 'gemini-3.5-transcribe';

    if (!isLargeFile) {
      // 1. Direkte Inline-Übergabe mit gemini-3.5-transcribe (ohne unsupported systemInstruction)
      let response: any;
      try {
        usedModel = 'gemini-3.5-transcribe';
        response = await ai.models.generateContent({
          model: 'gemini-3.5-transcribe',
          contents: [
            {
              role: 'user',
              parts: [
                {
                  inlineData: {
                    mimeType: mimeType,
                    data: audioBase64,
                  },
                },
                {
                  text: systemInstruction ? `${systemInstruction}\n\n${prompt}` : prompt,
                },
              ],
            },
          ],
          config: {
            maxOutputTokens: 65536,
            temperature: 0.0,
          },
        });
      } catch (e: any) {
        console.warn('[Transcribe Model] gemini-3.5-transcribe fallback auf gemini-2.5-flash:', e?.message || e);
        usedModel = 'gemini-2.5-flash';
        response = await ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: [
            {
              role: 'user',
              parts: [
                {
                  inlineData: {
                    mimeType: mimeType,
                    data: audioBase64,
                  },
                },
                {
                  text: prompt,
                },
              ],
            },
          ],
          config: genConfig,
        });
      }
      transcription = extractTranscriptionText(response);
    } else {
      // 2. Große Dateien (>18MB) via Files API mit Status-Check
      const tempFilePath = path.join(process.cwd(), `temp_recording_${Date.now()}.webm`);
      fs.writeFileSync(tempFilePath, buffer);

      try {
        let fileUpload = await ai.files.upload({
          file: tempFilePath,
          mimeType: mimeType,
        } as any);

        // Warten bis Datei im Status ACTIVE ist
        let state = fileUpload.state;
        let attempts = 0;
        while (state === 'PROCESSING' && attempts < 30) {
          await new Promise((r) => setTimeout(r, 2000));
          if (fileUpload.name) {
            fileUpload = await ai.files.get({ name: fileUpload.name });
            state = fileUpload.state;
          }
          attempts++;
        }

        let response: any;
        try {
          usedModel = 'gemini-3.5-transcribe';
          response = await ai.models.generateContent({
            model: 'gemini-3.5-transcribe',
            contents: [
              {
                role: 'user',
                parts: [
                  {
                    fileData: {
                      fileUri: fileUpload.uri,
                      mimeType: fileUpload.mimeType || mimeType,
                    },
                  },
                  {
                    text: systemInstruction ? `${systemInstruction}\n\n${prompt}` : prompt,
                  },
                ],
              },
            ],
            config: {
              maxOutputTokens: 65536,
              temperature: 0.0,
            },
          });
        } catch (e: any) {
          console.warn('[Transcribe Model Large] gemini-3.5-transcribe fallback auf gemini-2.5-flash:', e?.message || e);
          usedModel = 'gemini-2.5-flash';
          response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [
              {
                role: 'user',
                parts: [
                  {
                    fileData: {
                      fileUri: fileUpload.uri,
                      mimeType: fileUpload.mimeType || mimeType,
                    },
                  },
                  {
                    text: prompt,
                  },
                ],
              },
            ],
            config: genConfig,
          });
        }
        transcription = extractTranscriptionText(response);

        if (fileUpload.name) {
          try {
            await ai.files.delete({ name: fileUpload.name });
          } catch (delErr) {
            console.warn('File cleanup notice:', delErr);
          }
        }
      } finally {
        if (fs.existsSync(tempFilePath)) {
          fs.unlinkSync(tempFilePath);
        }
      }
    }

    // Automatischer Google Drive Export nach "Meet Recordings" NUR im Protokoll-Modus (nicht bei Live/Direkt-Diktat)
    let driveExportResult: any = null;
    if (mode === 'protocol') {
      try {
        const auth = getOAuth2Client();
        const drive = google.drive({ version: 'v3', auth });
        const folderId = await getOrCreateRecordingsFolder(drive);
        const isoDate = now.toISOString().split('T')[0];
        const isoTime = `${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}`;
        const fileName = `Transkript_${isoDate}_${isoTime}.md`;

        const fileMetadata: any = {
          name: fileName,
          mimeType: 'text/markdown',
        };
        if (folderId && folderId !== 'root') {
          fileMetadata.parents = [folderId];
        }

        const fileRes = await drive.files.create({
          requestBody: fileMetadata,
          media: {
            mimeType: 'text/markdown',
            body: transcription,
          },
          fields: 'id, name, webViewLink',
        });

        console.log(`[Auto-Drive-Export] Erfolgreich in "Meet Recordings" gespeichert: ${fileRes.data.name} (ID: ${fileRes.data.id})`);
        driveExportResult = {
          fileId: fileRes.data.id,
          fileName: fileRes.data.name,
          link: fileRes.data.webViewLink,
          folder: 'Meet Recordings',
        };
      } catch (driveErr: any) {
        console.warn('[Auto-Drive-Export] Warnung:', driveErr?.message || driveErr);
      }
    }

    res.json({
      success: true,
      transcription,
      languageDetected: language,
      modelUsed: usedModel,
      driveExport: driveExportResult,
    });
  } catch (error: any) {
    console.error('Transkriptionsfehler:', error);
    res.status(500).json({ error: error?.message || 'Fehler bei der Transkription.' });
  }
});

function extractTranscriptionText(response: any): string {
  if (!response) return '(Kein Text generiert)';
  if (response.text && typeof response.text === 'string' && response.text.trim() !== '') {
    return response.text.trim();
  }

  // Fallback: Prüfe auf spezifische Transkriptions-Parts im Response-Objekt
  const candidates = response.candidates || [];
  for (const cand of candidates) {
    const parts = cand.content?.parts || [];
    for (const part of parts) {
      if (part.text) return part.text.trim();
      if (part.audioTranscription?.text) return part.audioTranscription.text.trim();
      if (part.transcript?.text) return part.transcript.text.trim();
    }
  }
  return '(Kein Text generiert)';
}
async function getOrCreateRecordingsFolder(drive: any): Promise<string> {
  try {
    const folderName = 'Meet Recordings';
    const res = await drive.files.list({
      q: `name = '${folderName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id, name)',
      spaces: 'drive',
    });

    if (res.data.files && res.data.files.length > 0) {
      return res.data.files[0].id;
    }

    const folder = await drive.files.create({
      requestBody: {
        name: folderName,
        mimeType: 'application/vnd.google-apps.folder',
      },
      fields: 'id',
    });

    return folder.data.id;
  } catch (e) {
    console.warn('[Drive Folder] Fallback auf Root:', e);
    return 'root';
  }
}

// 2. Google Drive Export-Endpunkt
app.post('/api/drive/export', async (req, res) => {
  try {
    const { title = `Transkript_${new Date().toISOString().split('T')[0]}`, content } = req.body;
    if (!content) {
      return res.status(400).json({ error: 'Kein Inhalt zum Speichern vorhanden.' });
    }

    const auth = getOAuth2Client();
    const drive = google.drive({ version: 'v3', auth });

    // Ordner "Meet Recordings" ansteuern (exakt wie Google Meet)
    const folderId = await getOrCreateRecordingsFolder(drive);
    const fileName = title.endsWith('.md') ? title : `${title}.md`;

    const fileMetadata: any = {
      name: fileName,
      mimeType: 'text/markdown',
    };
    if (folderId && folderId !== 'root') {
      fileMetadata.parents = [folderId];
    }

    const media = {
      mimeType: 'text/markdown',
      body: content,
    };

    const fileRes = await drive.files.create({
      requestBody: fileMetadata,
      media: media,
      fields: 'id, name, webViewLink',
    });

    console.log(`[Drive Export] Gespeichert in "Meet Recordings": ${fileRes.data.name} (ID: ${fileRes.data.id})`);

    res.json({
      success: true,
      fileId: fileRes.data.id,
      fileName: fileRes.data.name,
      link: fileRes.data.webViewLink,
      folder: 'Meet Recordings',
    });
  } catch (error: any) {
    console.error('Drive Export Fehler:', error);
    res.status(500).json({ error: error?.message || 'Fehler beim Google Drive Export.' });
  }
});

/* Native Electron owns the Gemini Live connection now. The old renderer-facing
   WebSocket bridge was removed to keep the API key and live transport out of
   the renderer and to eliminate the localhost live endpoint. */
/*
 wss.on('connection', (clientWs: WebSocket) => {
  console.log('[Live Stream WS] Client verbunden');

  let geminiWs: WebSocket | null = null;
  const geminiLiveUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;

  try {
    geminiWs = new WebSocket(geminiLiveUrl);

    geminiWs.on('open', () => {
      console.log('[Live Stream WS] Verbindung zu Gemini Live API hergestellt');
      // Dieses Modell ist in unserem API-Projekt für bidiGenerateContent freigeschaltet.
      const setupMsg = {
        setup: {
          model: 'models/gemini-3.5-transcribe-live',
          generationConfig: {
            responseModalities: ['TEXT'],
            temperature: 0.0,
          },
          inputAudioTranscription: {},
          realtimeInputConfig: {
            automaticActivityDetection: {
              // Früherer Turn-Abschluss reduziert die gefühlte Latenz nach Sprechpausen.
              prefix_padding_ms: 80,
              silence_duration_ms: 350,
            },
          },
        },
      };
      geminiWs?.send(JSON.stringify(setupMsg));
    });

    geminiWs.on('message', (data: any) => {
      try {
        const parsed = JSON.parse(data.toString());
        if (parsed.setupComplete) {
          console.log('[Live Stream WS] Gemini Setup bestätigt');
        }
        if (parsed.error) {
          console.warn('[Live Stream WS] Gemini Serverfehler:', JSON.stringify(parsed.error));
        }
        // Nur bestätigte Input-Transkription nutzen. modelTurn kann Modelltext
        // statt wortgetreuer Transkription enthalten.
        const textChunk = parsed.serverContent?.inputTranscription?.text;
        if (textChunk && clientWs.readyState === WebSocket.OPEN) {
          console.log('[Live Stream WS] Transkript:', textChunk);
          clientWs.send(JSON.stringify({ type: 'text', text: textChunk }));
        }
      } catch (err) {
        console.warn('[Live Stream WS] Message parse notice:', err);
      }
    });

    geminiWs.on('error', (err) => {
      console.warn('[Live Stream WS] Gemini Live error:', err?.message || err);
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({ type: 'error', error: err?.message || String(err) }));
      }
    });

    geminiWs.on('close', (code, reason) => {
      console.log(`[Live Stream WS] Gemini Live geschlossen (${code}): ${reason.toString()}`);
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.close();
      }
    });
  } catch (e: any) {
    console.warn('[Live Stream WS] Init error:', e?.message || e);
  }

  // Client Audio Chunk Weiterleitung (Realtime PCM / Base64)
  clientWs.on('message', (msg: any) => {
    if (!geminiWs || geminiWs.readyState !== WebSocket.OPEN) return;
    try {
      const data = JSON.parse(msg.toString());
      if (data.type === 'audio' && data.data) {
        const clientState = clientWs as WebSocket & { __audioLogDone?: boolean };
        if (!clientState.__audioLogDone) {
          console.log('[Live Stream WS] Erste PCM-Audiodaten empfangen');
          clientState.__audioLogDone = true;
        }
        // Realtime Media Chunk an Gemini Live schicken
        const realtimeMsg = {
          realtimeInput: {
            mediaChunks: [
              {
                mimeType: 'audio/pcm;rate=16000',
                data: data.data,
              },
            ],
          },
        };
        geminiWs.send(JSON.stringify(realtimeMsg));
      }
    } catch {}
  });

  clientWs.on('close', () => {
    if (geminiWs && geminiWs.readyState === WebSocket.OPEN) {
      geminiWs.close();
    }
  });
 });
*/

// Statische Vite Build-Dateien ausliefern falls vorhanden
const distPath = path.join(process.cwd(), 'dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
      res.sendFile(path.join(distPath, 'index.html'));
    }
  });
}

// Nur Loopback: niemals im LAN/WLAN verfügbar machen.
server.listen(Number(PORT), '127.0.0.1', () => {
  console.log(`\n======================================================`);
  console.log(`🎙️  Google Transcriber läuft auf: http://127.0.0.1:${PORT}`);
  console.log(`======================================================\n`);
});
