# Google Transcriber

Eigenständige Desktop-Anwendung (Electron + React + Google Gemini) zur systemweiten Audioaufnahme von Meetings (Google Meet, Microsoft Teams, YouTube, Browser, System-Audio oder Mikrofon) mit automatischer Speech-to-Text-Transkription, Sprecher-Diarisierung und direktem Google Drive Export in den Ordner `Meet Recordings`.

---

## 🚀 Features

- **Systemweites Audio-Capture:** Nimmt beliebige Audio-Ausgänge (Meet, Videos, Systemaudio) oder Mikrofone auf – unabhängig von spezifischen Drittanbieter-Apps.
- **Echtzeit VU-Meter & Pegelanzeige:** Sofortige visuelle Rückmeldung, ob Audio anliegt und aufgenommen wird.
- **Offizielles Google-Protokoll-Format:**
  - Automatische Erkennung von Datum, Uhrzeit und Sprache (Deutsch / Englisch).
  - Strukturierte Teilnehmerliste, Agenda/Notizen und Aktionspunkte (To-Dos mit Verantwortlichen).
  - Vollständiges, wortgetreues Transkript (Verbatim) mit Sprecherzuordnung.
  - Reines Markdown (`.md`) ohne Emojis oder Format-Artefakte.
- **Automatischer Google Drive Export:** Speichert Protokolle standardmäßig direkt im Google Drive unter `Meet Recordings/`.
- **Hohe Skalierbarkeit & Datenschutz:**
  - Unterstützt Meetings bis zu mehreren Stunden Dauer (65.536 Output-Tokens, 1M Input-Tokens).
   - Audio wird nach der Transkription sofort vollständig aus Speicher und Cloud gelöscht.

## Aktueller Zwischenstand

- **Batch-Protokoll:** `gemini-3.5-transcribe` wird im Electron-Main-Prozess verwendet. Das Ergebnis wird automatisch als Markdown in `Meet Recordings` gespeichert.
- **Live-Diktat:** `gemini-3.5-transcribe-live` ist über eine bidirektionale Verbindung im Electron-Main-Prozess integriert. Der Renderer überträgt PCM-Audio ausschließlich über die gehärtete Preload-IPC-Bridge.
- **Latenz:** Das Live-Modell liefert bestätigte Segmente nach Voice-Activity-Erkennung, nicht jedes Wort als garantiertes Interim-Token. Die aktuelle Latenz liegt abhängig von Sprechpausen und API-Verarbeitung typischerweise bei mehreren Sekunden.
- **Cursor-Injektion:** Das aktive Zielfenster wird beim F9-Start per Windows-HWND gespeichert; Segmente werden anschließend atomar über native `SendInput`-Tastatureingabe eingefügt.
- **Known Limitation:** Anwendungen mit höherem Windows-Rechtestatus als der Transcriber können Eingaben durch Windows UIPI blockieren.

---

## 🛠️ Technologie-Stack & Architektur

- **Desktop Framework:** Electron + TypeScript
- **Frontend:** React 19, Tailwind CSS v4, Lucide Icons
- **Backend API:** Electron-Main-Prozess für Gemini, Live-Transport und Drive-Export; Express bleibt nur für optionale Entwicklungs-/Fallback-Endpunkte.
- **KI-Modelle:** `gemini-3.5-transcribe`, `gemini-3.5-transcribe-live`, Fallback `gemini-2.5-flash`
- **Persistenz:** Automatischer Upload via OAuth2 Refresh Token in Google Drive

---

## ⚡ Schnellstart

### 1. Installation

```bash
cd "C:\Users\HardyEngwer\Google Transcriber"
npm install
```

### 2. Konfiguration (`.env`)

Kopiere `.env.example` nach `.env` und stelle sicher, dass folgende Werte eingetragen sind:

```env
GEMINI_API_KEY=dein_gemini_api_key
GOOGLE_CLIENT_ID=deine_client_id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=dein_client_secret
GOOGLE_REFRESH_TOKEN=dein_refresh_token
PORT=3005
```

### 3. Anwendung starten

**Desktop-App starten:**
```bash
npm start
```
*(Oder per Doppelklick auf `start.cmd`)*

---

## 🎨 Vibe-Coding Hinweis

Dieses Repository wurde nach dem **Vibe-Coding-Prinzip** (KI-gestützte, iterative Architektur- und Code-Entwicklung) konzipiert und umgesetzt:
- **Konzentration auf Kern-UX:** Keine überflüssigen Menüs – nur Audioquelle, Pegel, REC und Ergebnis.
- **Resilientes API-Design:** Direkte In-Memory-Übergabe für kurze Audio-Clips und nahtloses Files-API-Handling für mehrstündige Konferenzen.
- **Strikte Sicherheitsgrenzen:** Kein dauerhaftes Speichern von Audiodaten, gehärtete Electron Preload-Bridge mit `contextIsolation: true` und `sandbox: true`.

## Sicherheit und Localhost

Die Produktions-Desktop-App lädt die Oberfläche aus dem lokalen `dist/`-Ordner in Electron. Der Produktionspfad verwendet native Electron-IPC; der API-Key und Google-Transport bleiben im Main-Prozess und werden nicht in den Renderer geladen.

Der optionale Express-Fallback bindet explizit nur an `127.0.0.1` und ist kein öffentlicher Webserver. Er wird vom Produktions-Renderer nicht angesprochen.

Die Live-Architektur und der Batch-/Drive-Pfad verwenden Electron-IPC zwischen Renderer und Main-Prozess; API-Key und Google-Transport verlassen den Main-Prozess nicht. Express bleibt nur als optionaler Entwicklungs-/Rückfallserver enthalten und wird vom Produktions-Renderer nicht mehr angesprochen.

---

## 📄 Lizenz

MIT License – Public Cloud Group (PCG)
