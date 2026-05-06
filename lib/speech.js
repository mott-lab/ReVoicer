// PDF Converser - Speech Capture Module
// Hybrid approach: Web Speech API for live preview + MediaRecorder for Whisper

class SpeechCapture {
  constructor() {
    this.recognition = null;
    this.mediaRecorder = null;
    this.audioChunks = [];
    this.audioBlob = null;
    this.mediaStream = null;
    this.isRecording = false;
    this.transcript = '';
    this.onResult = null;
    this.onError = null;
    this.onEnd = null;
  }

  async start() {
    this.transcript = '';
    this.audioChunks = [];
    this.audioBlob = null;

    // Start MediaRecorder for audio capture (used by Whisper)
    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.mediaRecorder = new MediaRecorder(this.mediaStream, {
        mimeType: this._getSupportedMimeType(),
      });
      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          this.audioChunks.push(event.data);
        }
      };
      this.mediaRecorder.onstop = () => {
        this.audioBlob = new Blob(this.audioChunks, {
          type: this.mediaRecorder.mimeType,
        });
      };
      this.mediaRecorder.start(1000); // collect in 1s chunks
    } catch (err) {
      this.onError?.('Microphone access denied');
      return;
    }

    // Start live-preview recognizer (best-effort, non-critical). Prefer the
    // desktop's Vosk shim when present — Electron's webkitSpeechRecognition
    // is a no-op there. In the browser-extension build, fall back to the
    // native Web Speech API.
    const SpeechRecognition =
      window.__voskRecognition ||
      window.SpeechRecognition ||
      window.webkitSpeechRecognition;
    if (SpeechRecognition) {
      this.recognition = new SpeechRecognition();
      this.recognition.continuous = true;
      this.recognition.interimResults = true;
      this.recognition.lang = 'en-US';

      this.recognition.onresult = (event) => {
        let interim = '';
        let finalText = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          if (event.results[i].isFinal) {
            finalText += event.results[i][0].transcript;
          } else {
            interim += event.results[i][0].transcript;
          }
        }
        this.transcript += finalText;
        this.onResult?.(this.transcript, interim);
      };

      this.recognition.onerror = () => {
        // Non-critical — we still have the audio recording for Whisper
      };

      this.recognition.onend = () => {
        // Don't trigger onEnd here — we wait for stop() to be called
      };

      try {
        this.recognition.start();
      } catch {
        // Web Speech API not available, that's fine — Whisper will handle it
      }
    }

    this.isRecording = true;
  }

  stop() {
    if (!this.isRecording) return;
    this.isRecording = false;

    // Stop Web Speech API
    if (this.recognition) {
      try { this.recognition.stop(); } catch {}
      this.recognition = null;
    }

    // Stop MediaRecorder and wait for data
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.onstop = () => {
        this.audioBlob = new Blob(this.audioChunks, {
          type: this.mediaRecorder.mimeType,
        });
        this._stopMediaStream();
        this.onEnd?.(this.transcript, this.audioBlob);
      };
      this.mediaRecorder.stop();
    } else {
      this._stopMediaStream();
      this.onEnd?.(this.transcript, null);
    }
  }

  _stopMediaStream() {
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(track => track.stop());
      this.mediaStream = null;
    }
  }

  _getSupportedMimeType() {
    // Prefer webm/opus (smaller files), fall back to wav-compatible formats
    const types = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/mp4',
    ];
    for (const type of types) {
      if (MediaRecorder.isTypeSupported(type)) return type;
    }
    return ''; // Let the browser pick
  }
}
