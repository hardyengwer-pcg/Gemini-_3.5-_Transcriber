import React, { useState, useRef, useEffect } from 'react';
import { 
  Mic, 
  Square, 
  Volume2, 
  Globe, 
  HardDriveDownload, 
  Sparkles, 
  Copy, 
  Check, 
  Radio, 
  Loader2, 
  FileText,
  VolumeX,
  Minimize2,
  Maximize2
} from 'lucide-react';

export function App() {
  const [isRecording, setIsRecording] = useState(false);
  const [recordTime, setRecordTime] = useState(0);
  const [audioLevel, setAudioLevel] = useState(0);
  const [selectedLanguage, setSelectedLanguage] = useState<'auto' | 'de' | 'en'>('auto');
  const [captureSource, setCaptureSource] = useState<'both' | 'mic' | 'system'>('both');
  const [transcriptionMode, setTranscriptionMode] = useState<'protocol' | 'direct'>('protocol');
  const [inputDevices, setInputDevices] = useState<MediaDeviceInfo[]>([]);
  const [outputDevices, setOutputDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedInputId, setSelectedInputId] = useState<string>('');
  const [selectedOutputId, setSelectedOutputId] = useState<string>('');
  const [transcription, setTranscription] = useState<string | null>(null);
  const [activeModel, setActiveModel] = useState<string>('gemini-3.5-transcribe');
  const [isLoading, setIsLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string>('Bereit für Aufnahme');
  const [copied, setCopied] = useState(false);
  const [exportedLink, setExportedLink] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [isCompact, setIsCompact] = useState(false);

  const toggleCompactMode = async () => {
    const next = !isCompact;
    setIsCompact(next);
    if ((window as any).electronAPI?.setCompactMode) {
      await (window as any).electronAPI.setCompactMode(next);
    }
  };

  // Automatische Erkennung aller Ein- und Ausgänge beim Start
  const transcriptionModeRef = useRef<'protocol' | 'direct'>('protocol');

  useEffect(() => {
    transcriptionModeRef.current = transcriptionMode;
  }, [transcriptionMode]);

  useEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);

  useEffect(() => {
    async function initAudioDevices() {
      try {
        const testStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const allDevices = await navigator.mediaDevices.enumerateDevices();
        testStream.getTracks().forEach((t) => t.stop());

        const inputs = allDevices.filter((d) => d.kind === 'audioinput');
        const outputs = allDevices.filter((d) => d.kind === 'audiooutput');

        console.log('[Audio Devices] Eingänge:', inputs);
        console.log('[Audio Devices] Ausgänge:', outputs);

        setInputDevices(inputs);
        setOutputDevices(outputs);

        if (inputs.length > 0 && !selectedInputId) setSelectedInputId(inputs[0].deviceId);
        if (outputs.length > 0 && !selectedOutputId) setSelectedOutputId(outputs[0].deviceId);
      } catch (err) {
        console.warn('Initial device enumeration notice:', err);
        try {
          const fallbackDevices = await navigator.mediaDevices.enumerateDevices();
          setInputDevices(fallbackDevices.filter((d) => d.kind === 'audioinput'));
          setOutputDevices(fallbackDevices.filter((d) => d.kind === 'audiooutput'));
        } catch {}
      }
    }

    initAudioDevices();

    const handleDeviceChange = async () => {
      const devList = await navigator.mediaDevices.enumerateDevices();
      setInputDevices(devList.filter((d) => d.kind === 'audioinput'));
      setOutputDevices(devList.filter((d) => d.kind === 'audiooutput'));
    };

    navigator.mediaDevices.addEventListener('devicechange', handleDeviceChange);

    // Globaler F9-Hotkey Listener aus Electron: Schaltet bei Tastendruck IMMER automatisch auf "Direkt-Diktat"
    if ((window as any).electronAPI?.onToggleRecording) {
      (window as any).electronAPI.onToggleRecording(() => {
        if (isRecordingRef.current) {
          stopRecording();
        } else {
          setTranscriptionMode('direct');
          transcriptionModeRef.current = 'direct';
          startRecording('direct');
        }
      });
    }

    return () => {
      navigator.mediaDevices.removeEventListener('devicechange', handleDeviceChange);
    };
  }, []);

  const liveWsRef = useRef<WebSocket | null>(null);
  const audioContextWorkletRef = useRef<AudioContext | null>(null);
  const liveActiveRef = useRef(false);
  const isRecordingRef = useRef(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const timerIntervalRef = useRef<any>(null);

  // Timer Effekt
  useEffect(() => {
    if (isRecording) {
      timerIntervalRef.current = setInterval(() => {
        setRecordTime((prev) => prev + 1);
      }, 1000);
    } else {
      clearInterval(timerIntervalRef.current);
      setRecordTime(0);
    }
    return () => clearInterval(timerIntervalRef.current);
  }, [isRecording]);

  useEffect(() => {
    const electronAPI = (window as any).electronAPI;
    if (!electronAPI?.onLiveText) return;
    electronAPI.onLiveText(async (text: string) => {
      if (!liveActiveRef.current || !text) return;
      setTranscription((prev) => (prev ? prev + text : text));
      await electronAPI.typeTextAtCursor(text);
    });
    electronAPI.onLiveError((error: string) => {
      if (liveActiveRef.current) setStatusMessage(`Live-Fehler: ${error}`);
    });
  }, []);

  // Audio Pegel Messung mit AudioContext und TimeDomain Float Daten
  const setupAudioMeter = (stream: MediaStream) => {
    try {
      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      if (audioContext.state === 'suspended') {
        audioContext.resume().catch(() => {});
      }
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.2;
      const source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);

      audioContextRef.current = audioContext;
      analyserRef.current = analyser;

      const dataArray = new Float32Array(analyser.fftSize);

      const updateMeter = () => {
        if (!analyserRef.current) return;
        analyserRef.current.getFloatTimeDomainData(dataArray);

        // RMS (Root Mean Square) Lautstärke-Berechnung
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          sum += dataArray[i] * dataArray[i];
        }
        const rms = Math.sqrt(sum / dataArray.length);
        // Pegel auf 0 - 100 skalieren mit logarithmischer Empfindlichkeit
        const db = 20 * Math.log10(Math.max(rms, 0.0001));
        const normalized = Math.min(100, Math.max(0, Math.round(((db + 50) / 50) * 100)));

        setAudioLevel(normalized);
        animationFrameRef.current = requestAnimationFrame(updateMeter);
      };

      updateMeter();
    } catch (e) {
      console.warn('Audio meter error:', e);
    }
  };

  const cleanupAudio = () => {
    if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    analyserRef.current = null;
    setAudioLevel(0);
  };

  const startRecording = async (overrideMode?: 'protocol' | 'direct') => {
    try {
      const activeMode = overrideMode || transcriptionModeRef.current;
      setExportedLink(null);
      setTranscription(null);
      audioChunksRef.current = [];

      let stream: MediaStream;

      const getSystemAudioStream = async (): Promise<MediaStream> => {
        if ((window as any).electronAPI?.getDesktopSources) {
          const sources = await (window as any).electronAPI.getDesktopSources();
          const primaryScreen = sources[0] || { id: 'screen:0:0' };
          const rawStream = await (navigator.mediaDevices as any).getUserMedia({
            audio: { mandatory: { chromeMediaSource: 'desktop' } },
            video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: primaryScreen.id } },
          });
          const audioTracks = rawStream.getAudioTracks();
          rawStream.getVideoTracks().forEach((track: MediaStreamTrack) => track.stop());
          if (audioTracks.length === 0) throw new Error('Kein Windows-Systemaudio verfügbar.');
          return new MediaStream(audioTracks);
        }

        const rawStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        });
        const audioTracks = rawStream.getAudioTracks();
        rawStream.getVideoTracks().forEach((track) => track.stop());
        if (audioTracks.length === 0) throw new Error('Bitte Systemaudio im Freigabedialog aktivieren.');
        return new MediaStream(audioTracks);
      };

      if (captureSource === 'both') {
        setStatusMessage('Mikrofon & Lautsprecher werden aufgenommen...');

        // 1. Mikrofon-Stream holen
        const micConstraints = selectedInputId ? { deviceId: { exact: selectedInputId } } : true;
        const micStream = await navigator.mediaDevices.getUserMedia({
          audio: micConstraints,
          video: false,
        });

        // 2. System-Audio Loopback holen (Electron Desktop Capture)
        let systemStream: MediaStream | null = null;
        try {
          systemStream = await getSystemAudioStream();
        } catch (e) {
          console.warn('System audio cancel/error in both mode:', e);
        }

        if (systemStream && systemStream.getAudioTracks().length > 0) {
          const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
          const dest = audioCtx.createMediaStreamDestination();

          const micNode = audioCtx.createMediaStreamSource(micStream);
          const sysNode = audioCtx.createMediaStreamSource(systemStream);

          micNode.connect(dest);
          sysNode.connect(dest);

          stream = dest.stream;
        } else {
          stream = micStream;
        }
      } else if (captureSource === 'system') {
        setStatusMessage('Lautsprecher / System-Audio wird verbunden...');
        
        stream = await getSystemAudioStream();
      } else {
        setStatusMessage('Mikrofon wird initialisiert...');
        const audioConstraints = selectedInputId
          ? { deviceId: { exact: selectedInputId } }
          : true;

        stream = await navigator.mediaDevices.getUserMedia({
          audio: audioConstraints,
          video: false,
        });
      }

      setupAudioMeter(stream);

      // Native Electron IPC Streaming für Direkt-Modus.
      if (activeMode === 'direct') {
        try {
          liveActiveRef.current = true;
          await (window as any).electronAPI.startLive();

          // AudioContext für 16kHz PCM Audio-Stream Erzeugung
          const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
          audioContextWorkletRef.current = audioCtx;
          const sourceNode = audioCtx.createMediaStreamSource(stream);
          const processorNode = audioCtx.createScriptProcessor(4096, 1, 1);

          processorNode.onaudioprocess = (e) => {
            const inputData = e.inputBuffer.getChannelData(0);

            // Float32 zu Int16 PCM konvertieren
            const pcm16 = new Int16Array(inputData.length);
            for (let i = 0; i < inputData.length; i++) {
              const s = Math.max(-1, Math.min(1, inputData[i]));
              pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
            }

            // In Base64 kodieren und an WebSocket schicken
            const u8 = new Uint8Array(pcm16.buffer);
            let binary = '';
            for (let i = 0; i < u8.byteLength; i++) {
              binary += String.fromCharCode(u8[i]);
            }
            const b64 = window.btoa(binary);

            (window as any).electronAPI.sendLiveAudio(b64);
          };

          sourceNode.connect(processorNode);
          processorNode.connect(audioCtx.destination);
        } catch (wsErr) {
          liveActiveRef.current = false;
          console.warn('Native Live IPC setup notice:', wsErr);
          setStatusMessage('Live-Transkription konnte nicht verbunden werden.');
        }
      }

      // Unterstützte reine Audio-MimeTypes ermitteln
      const mimeTypes = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/ogg;codecs=opus',
        'audio/mp4',
      ];
      const supportedMimeType = mimeTypes.find((t) => MediaRecorder.isTypeSupported(t)) || '';

      const recorderOptions: MediaRecorderOptions = supportedMimeType ? { mimeType: supportedMimeType } : {};
      const mediaRecorder = new MediaRecorder(stream, recorderOptions);
      let appendQueue = Promise.resolve();

      if (activeMode === 'protocol') {
        await (window as any).electronAPI.startRecordingFile();
      }

      mediaRecorder.ondataavailable = async (event: BlobEvent) => {
        if (event.data && event.data.size > 0) {
          if (activeMode === 'protocol') {
            // Nicht im Renderer puffern: direkt in die temporäre Main-Prozess-Datei schreiben.
            appendQueue = appendQueue.then(async () => {
              await (window as any).electronAPI.appendRecordingChunk(await event.data.arrayBuffer());
            });
          } else {
            audioChunksRef.current.push(event.data);
          }
        }
      };

      mediaRecorder.onstop = async () => {
        cleanupAudio();
        stream.getTracks().forEach((t) => t.stop());

        liveActiveRef.current = false;
        try { await (window as any).electronAPI.stopLive(); } catch {}
        if (audioContextWorkletRef.current) {
          try { audioContextWorkletRef.current.close(); } catch {}
          audioContextWorkletRef.current = null;
        }

        if (activeMode === 'direct') {
          setStatusMessage('Live-Diktat beendet.');
        } else {
          await appendQueue;
          setIsLoading(true);
          setStatusMessage('Meeting-Datei wird sicher verarbeitet...');
          const data = await (window as any).electronAPI.finishRecordingFile({
            mimeType: supportedMimeType || 'audio/webm',
            language: selectedLanguage,
          });
          setTranscription(data.transcription);
          if (data.modelUsed) setActiveModel(data.modelUsed);
          if (data.driveExport?.link) {
            setExportedLink(data.driveExport.link);
            setStatusMessage(`Protokoll fertig und in Drive gespeichert: ${data.driveExport.fileName}`);
          }
          setIsLoading(false);
        }
      };

      mediaRecorderRef.current = mediaRecorder;
      mediaRecorder.start(1000); // chunk jede Sekunde
      setIsRecording(true);
      isRecordingRef.current = true;
      setStatusMessage(activeMode === 'direct' ? 'Live-Diktat aktiv: Text tippt live beim Sprechen...' : 'Aufnahme läuft...');
    } catch (err: any) {
      console.error('Recording start error:', err);
      setStatusMessage(`Fehler: ${err.message || 'Aufnahme konnte nicht gestartet werden'}`);
      cleanupAudio();
      setIsRecording(false);
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      isRecordingRef.current = false;
      setStatusMessage('Verarbeite Aufnahme...');
    }
  };

  const handleTranscription = async (blob: Blob) => {
    setIsLoading(true);
    setStatusMessage('Transkribiere mit Gemini Speech-to-Text...');

    try {
      const reader = new FileReader();
      reader.readAsDataURL(blob);
      reader.onloadend = async () => {
        const base64Data = (reader.result as string).split(',')[1];

        const activeMode = transcriptionModeRef.current;
        const data = await (window as any).electronAPI.transcribeAudio({
          audioBase64: base64Data,
          mimeType: blob.type || 'audio/webm',
          language: selectedLanguage,
          mode: activeMode,
        });

        setTranscription(data.transcription);
        if (data.modelUsed) {
          setActiveModel(data.modelUsed);
        }

        // Im "Direkt"-Modus: Text sofort an die Cursor-Position im aktiven Fenster tippen!
        if (activeMode === 'direct') {
          if ((window as any).electronAPI?.typeTextAtCursor) {
            await (window as any).electronAPI.typeTextAtCursor(data.transcription);
            setStatusMessage('Diktat direkt an Cursor-Position eingefügt!');
          }
        } else if (data.driveExport?.link) {
          setExportedLink(data.driveExport.link);
          setStatusMessage(`Transkription fertig & automatisch in Google Drive gespeichert (${data.driveExport.fileName})!`);
        } else {
          setStatusMessage('Transkription erfolgreich abgeschlossen!');
        }
        setIsLoading(false);
      };
    } catch (err: any) {
      console.error('Transcription error:', err);
      setStatusMessage(`Fehler: ${err.message || 'Transkription fehlgeschlagen'}`);
      setIsLoading(false);
    }
  };

  const handleDriveExport = async () => {
    if (!transcription) return;
    setIsExporting(true);
    try {
      const now = new Date();
      const dateStr = now.toISOString().split('T')[0];
      const timeStr = `${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}`;
      const title = `Transkript_${dateStr}_${timeStr}`;

      const data = await (window as any).electronAPI.exportDrive({ title, content: transcription });

      setExportedLink(data.link);
      setStatusMessage(`Erfolgreich in Google Drive gespeichert: ${data.fileName}`);
    } catch (err: any) {
      console.error('Drive Export Error:', err);
      alert(`Fehler beim Speichern in Drive: ${err.message}`);
    } finally {
      setIsExporting(false);
    }
  };

  const copyToClipboard = () => {
    if (transcription) {
      navigator.clipboard.writeText(transcription);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const formatTimer = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  };

  if (isCompact) {
    return (
      <div className="h-screen w-screen bg-zinc-950 text-zinc-100 p-3 flex flex-col justify-between select-none overflow-hidden border border-zinc-800">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className={`w-2.5 h-2.5 rounded-full ${isRecording ? 'bg-rose-500 animate-ping' : 'bg-emerald-500'}`} />
            <span className="font-mono text-xs font-bold">{formatTimer(recordTime)}</span>
          </div>

          {/* Mode Toggle in Mini View */}
          <div className="flex items-center gap-1 bg-zinc-900 p-0.5 rounded-lg border border-zinc-800">
            <button
              type="button"
              onClick={() => !isRecording && setTranscriptionMode('protocol')}
              disabled={isRecording}
              className={`text-[9px] px-1.5 py-0.5 rounded font-medium transition-colors ${
                transcriptionMode === 'protocol' ? 'bg-zinc-800 text-white font-bold' : 'text-zinc-500'
              }`}
            >
              Protokoll
            </button>
            <button
              type="button"
              onClick={() => !isRecording && setTranscriptionMode('direct')}
              disabled={isRecording}
              className={`text-[9px] px-1.5 py-0.5 rounded font-medium transition-colors ${
                transcriptionMode === 'direct' ? 'bg-rose-600 text-white font-bold' : 'text-zinc-500'
              }`}
            >
              Direkt ✍️
            </button>
          </div>

          <button
            type="button"
            onClick={toggleCompactMode}
            className="p-1 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-white transition-colors"
            title="Vollansicht"
          >
            <Maximize2 className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Pegelbalken */}
        <div className="flex flex-col gap-1 my-auto">
          <div className="h-1.5 w-full bg-zinc-900 rounded-full overflow-hidden">
            <div
              className={`h-full transition-all duration-75 ${
                audioLevel > 75 ? 'bg-rose-500' : audioLevel > 40 ? 'bg-amber-400' : 'bg-emerald-400'
              }`}
              style={{ width: `${audioLevel}%` }}
            />
          </div>
        </div>

        {/* REC / STOP Button */}
        <div>
          {!isRecording ? (
            <button
              type="button"
              onClick={() => startRecording()}
              disabled={isLoading}
              className="w-full flex items-center justify-center gap-2 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-semibold text-xs transition-all shadow-md active:scale-95"
            >
              <Mic className="w-3.5 h-3.5" />
              <span>{transcriptionMode === 'direct' ? 'Direkt diktieren (REC)' : 'REC'}</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={stopRecording}
              className="w-full flex items-center justify-center gap-2 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-rose-400 border border-rose-500/30 font-semibold text-xs transition-all shadow-md active:scale-95 animate-pulse"
            >
              <Square className="w-3.5 h-3.5 fill-rose-500" />
              <span>{transcriptionMode === 'direct' ? 'Einfügen (STOP)' : 'STOP'}</span>
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 flex flex-col gap-6">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-zinc-800/80 pb-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-rose-500 to-amber-500 flex items-center justify-center shadow-lg shadow-rose-500/20">
            <Radio className="w-5 h-5 text-white animate-pulse" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-white flex items-center gap-2">
              Google Transcriber
              <span className="text-[11px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-rose-500/10 text-rose-400 border border-rose-500/20 font-mono">
                {activeModel}
              </span>
            </h1>
            <p className="text-xs text-zinc-400">Systemaudio & Meetings in Echtzeit aufnehmen, transkribieren & in Google Drive sichern</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Compact Mode Toggle */}
          <button
            type="button"
            onClick={toggleCompactMode}
            className="text-xs py-1.5 px-3 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-300 flex items-center gap-1.5 transition-colors"
            title="In Mini-Fenster umschalten"
          >
            <Minimize2 className="w-3.5 h-3.5 text-zinc-400" />
            Mini-Modus
          </button>

          {/* Status Badge */}
          <div className="text-xs px-3 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-300 flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${isRecording ? 'bg-rose-500 animate-ping' : 'bg-emerald-500'}`} />
            {statusMessage}
          </div>
        </div>
      </header>

      {/* Main Control Console */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Settings Card */}
        <div className="bg-zinc-900/60 border border-zinc-800/80 rounded-2xl p-5 flex flex-col gap-5 backdrop-blur-xl">
          <h2 className="text-sm font-semibold text-zinc-200 flex items-center gap-2">
            <Globe className="w-4 h-4 text-zinc-400" />
            Audio- & Sprachquelle
          </h2>

          {/* Source Toggle */}
          <div className="flex flex-col gap-2">
            <label className="text-xs font-medium text-zinc-400">Aufnahmemodus</label>
            <div className="grid grid-cols-3 gap-1.5 bg-zinc-950/80 p-1 rounded-xl border border-zinc-800/60 text-center">
              <button
                type="button"
                onClick={() => !isRecording && setCaptureSource('both')}
                disabled={isRecording}
                className={`text-[11px] py-2 px-1 rounded-lg font-medium transition-all ${
                  captureSource === 'both'
                    ? 'bg-zinc-800 text-white shadow-sm'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                Beides (Meeting)
              </button>
              <button
                type="button"
                onClick={() => !isRecording && setCaptureSource('mic')}
                disabled={isRecording}
                className={`text-[11px] py-2 px-1 rounded-lg font-medium transition-all ${
                  captureSource === 'mic'
                    ? 'bg-zinc-800 text-white shadow-sm'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                Nur Mikrofon
              </button>
              <button
                type="button"
                onClick={() => !isRecording && setCaptureSource('system')}
                disabled={isRecording}
                className={`text-[11px] py-2 px-1 rounded-lg font-medium transition-all ${
                  captureSource === 'system'
                    ? 'bg-zinc-800 text-white shadow-sm'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                Nur Ausgang
              </button>
            </div>
          </div>

          {/* Device Selection when Mic or Both mode is active */}
          {captureSource === 'mic' && (
            <div className="flex flex-col gap-2">
              <label className="text-xs font-medium text-zinc-400">Mikrofon / Spracheingang</label>
              <select
                value={selectedInputId}
                onChange={(e) => setSelectedInputId(e.target.value)}
                disabled={isRecording}
                className="bg-zinc-950/80 border border-zinc-800 text-zinc-200 text-xs rounded-xl px-3 py-2.5 focus:outline-none focus:border-rose-500 transition-colors truncate"
              >
                {inputDevices.length > 0 ? (
                  inputDevices.map((dev) => (
                    <option key={dev.deviceId} value={dev.deviceId}>
                      {dev.label || `Mikrofon (${dev.deviceId.slice(0, 8)}...)`}
                    </option>
                  ))
                ) : (
                  <option value="">Kein Mikrofon gefunden</option>
                )}
              </select>
            </div>
          )}

          {captureSource === 'both' && (
            <div className="flex flex-col gap-2">
              <label className="text-xs font-medium text-zinc-400">Dein Mikrofon (Eigene Stimme)</label>
              <select
                value={selectedInputId}
                onChange={(e) => setSelectedInputId(e.target.value)}
                disabled={isRecording}
                className="bg-zinc-950/80 border border-zinc-800 text-zinc-200 text-xs rounded-xl px-3 py-2.5 focus:outline-none focus:border-rose-500 transition-colors truncate"
              >
                {inputDevices.length > 0 ? (
                  inputDevices.map((dev) => (
                    <option key={dev.deviceId} value={dev.deviceId}>
                      {dev.label || `Mikrofon (${dev.deviceId.slice(0, 8)}...)`}
                    </option>
                  ))
                ) : (
                  <option value="">Kein Mikrofon gefunden</option>
                )}
              </select>
              <p className="text-[10px] text-zinc-500 leading-tight">
                Meeting-Sound der anderen Teilnehmer wird beim Klick auf REC automatisch zugeschaltet.
              </p>
            </div>
          )}

          {captureSource === 'system' && (
            <div className="flex flex-col gap-2">
              <label className="text-xs font-medium text-zinc-400">Lautsprecher-Ausgang (Meeting / YouTube)</label>
              <div className="p-2.5 rounded-xl bg-zinc-950/80 border border-zinc-800 text-zinc-300 text-xs flex items-center gap-2">
                <Volume2 className="w-4 h-4 text-rose-400 shrink-0" />
                <span>Nimmt den gesamten Windows-Audioausgang ohne Mikrofon auf.</span>
              </div>
            </div>
          )}

          {/* Output Format Mode */}
          <div className="flex flex-col gap-2">
            <label className="text-xs font-medium text-zinc-400">Verarbeitungsziel</label>
            <div className="grid grid-cols-2 gap-2 bg-zinc-950/80 p-1 rounded-xl border border-zinc-800/60">
              <button
                type="button"
                onClick={() => !isRecording && setTranscriptionMode('protocol')}
                disabled={isRecording}
                className={`text-xs py-2 px-2 rounded-lg font-medium transition-all ${
                  transcriptionMode === 'protocol'
                    ? 'bg-zinc-800 text-white shadow-sm'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                Protokoll & Drive
              </button>
              <button
                type="button"
                onClick={() => !isRecording && setTranscriptionMode('direct')}
                disabled={isRecording}
                className={`text-xs py-2 px-2 rounded-lg font-medium transition-all ${
                  transcriptionMode === 'direct'
                    ? 'bg-rose-600 text-white shadow-sm font-semibold'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                Direkt am Cursor ✍️
              </button>
            </div>
            {transcriptionMode === 'direct' && (
              <div className="p-2.5 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300 text-[11px] flex items-center justify-between">
                <span>💡 <strong>Hotkey:</strong> Drücke jederzeit <strong>F9</strong> zum Starten & Stoppen!</span>
              </div>
            )}
          </div>

          {/* Language Selection */}
          <div className="flex flex-col gap-2">
            <label className="text-xs font-medium text-zinc-400">Sprache</label>
            <select
              value={selectedLanguage}
              onChange={(e) => setSelectedLanguage(e.target.value as any)}
              disabled={isRecording}
              className="bg-zinc-950/80 border border-zinc-800 text-zinc-200 text-xs rounded-xl px-3 py-2.5 focus:outline-none focus:border-rose-500 transition-colors"
            >
              <option value="auto">✨ Auto-Detect (Deutsch / Englisch)</option>
              <option value="de">🇩🇪 Deutsch (de-DE)</option>
              <option value="en">🇺🇸 English (en-US)</option>
            </select>
          </div>
        </div>

        {/* Center Recorder & VU Meter */}
        <div className="md:col-span-2 bg-gradient-to-b from-zinc-900/80 to-zinc-950 border border-zinc-800/80 rounded-2xl p-6 flex flex-col items-center justify-center gap-6 relative overflow-hidden shadow-2xl">
          {/* Audio Wave Visualizer Background */}
          {isRecording && (
            <div 
              className="absolute inset-0 bg-rose-500/5 blur-3xl transition-opacity duration-300 pointer-events-none"
              style={{ opacity: audioLevel / 100 }}
            />
          )}

          {/* Timer Display */}
          <div className="font-mono text-3xl font-bold tracking-widest text-zinc-100 flex items-center gap-3">
            <div className={`w-3 h-3 rounded-full ${isRecording ? 'bg-rose-500 animate-pulse' : 'bg-zinc-700'}`} />
            {formatTimer(recordTime)}
          </div>

          {/* Live VU Meter Bar */}
          <div className="w-full max-w-md flex flex-col gap-1.5">
            <div className="flex justify-between text-[11px] text-zinc-500 font-medium">
              <span className="flex items-center gap-1">
                {audioLevel > 5 ? <Volume2 className="w-3.5 h-3.5 text-zinc-400" /> : <VolumeX className="w-3.5 h-3.5 text-zinc-600" />}
                Eingangspegel
              </span>
              <span>{audioLevel}%</span>
            </div>
            <div className="h-2 w-full bg-zinc-950 rounded-full overflow-hidden border border-zinc-800 p-0.5">
              <div
                className={`h-full rounded-full transition-all duration-75 ${
                  audioLevel > 75 
                    ? 'bg-rose-500' 
                    : audioLevel > 40 
                    ? 'bg-amber-400' 
                    : 'bg-emerald-400'
                }`}
                style={{ width: `${audioLevel}%` }}
              />
            </div>
          </div>

          {/* REC Button */}
          <div className="flex items-center gap-4">
            {!isRecording ? (
              <button
                type="button"
                onClick={() => startRecording()}
                disabled={isLoading}
                className="group relative flex items-center gap-3 px-8 py-3.5 rounded-full bg-rose-600 hover:bg-rose-500 text-white font-semibold text-sm shadow-xl shadow-rose-600/25 transition-all hover:scale-105 active:scale-95 cursor-pointer disabled:opacity-50"
              >
                <Mic className="w-5 h-5 text-white transition-transform group-hover:scale-110" />
                <span>Aufnahme starten (REC)</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={stopRecording}
                className="flex items-center gap-3 px-8 py-3.5 rounded-full bg-zinc-800 hover:bg-zinc-700 text-rose-400 border border-rose-500/30 font-semibold text-sm shadow-xl transition-all hover:scale-105 active:scale-95 cursor-pointer animate-pulse"
              >
                <Square className="w-5 h-5 text-rose-500 fill-rose-500" />
                <span>Aufnahme stoppen & transkribieren</span>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Transcription Output Console */}
      <div className="bg-zinc-900/60 border border-zinc-800/80 rounded-2xl p-6 flex flex-col gap-4 backdrop-blur-xl">
        <div className="flex items-center justify-between border-b border-zinc-800/60 pb-4">
          <h2 className="text-sm font-semibold text-zinc-200 flex items-center gap-2">
            <FileText className="w-4 h-4 text-zinc-400" />
            Transkript & Gesprächsprotokoll
          </h2>

          {transcription && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={copyToClipboard}
                className="flex items-center gap-1.5 text-xs py-1.5 px-3 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700/60 transition-colors"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                {copied ? 'Kopiert' : 'Kopieren'}
              </button>

              <button
                type="button"
                onClick={handleDriveExport}
                disabled={isExporting}
                className="flex items-center gap-1.5 text-xs py-1.5 px-3 rounded-lg bg-rose-600/20 hover:bg-rose-600/30 text-rose-300 border border-rose-500/30 transition-colors disabled:opacity-50"
              >
                {isExporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <HardDriveDownload className="w-3.5 h-3.5" />}
                In Google Drive speichern
              </button>
            </div>
          )}
        </div>

        {/* Content Box */}
        <div className="min-h-[220px] rounded-xl bg-zinc-950/70 border border-zinc-800/60 p-5 font-mono text-xs leading-relaxed text-zinc-300 whitespace-pre-wrap selection:bg-rose-500/30">
          {isLoading ? (
            <div className="h-48 flex flex-col items-center justify-center gap-3 text-zinc-400">
              <Loader2 className="w-6 h-6 animate-spin text-rose-500" />
              <span>Verarbeite Audioaufnahme und erstelle Transkript mit Gemini...</span>
            </div>
          ) : transcription ? (
            transcription
          ) : (
            <div className="h-48 flex flex-col items-center justify-center gap-2 text-zinc-500">
              <Sparkles className="w-6 h-6 text-zinc-600" />
              <span>Noch kein Transkript vorhanden. Starte eine Aufnahme mit REC.</span>
            </div>
          )}
        </div>

        {/* Drive Success Link */}
        {exportedLink && (
          <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-xs flex items-center justify-between">
            <span>Datei erfolgreich in Google Drive gesichert!</span>
            <a
              href={exportedLink}
              target="_blank"
              rel="noopener noreferrer"
              className="underline font-semibold hover:text-emerald-200"
            >
              Im Drive öffnen ↗
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
export default App;
