// Speech-to-text: the only way to get text off the glasses, since there's no
// keyboard. Abstracted so the input path is swappable — the browser/WebView
// backend uses the Web Speech API; on-device you may instead capture G2 mic
// audio (PCM 16kHz mono, `g2-microphone` permission) via the SDK and run it
// through your ASR of choice (see the everything-evenhub ASR template).

export interface Dictation {
  supported(): boolean;
  // Begin listening. onPartial streams interim text; resolves with the final
  // transcript when speech ends or stop() is called. Rejects on error/denied.
  start(onPartial: (text: string) => void): Promise<string>;
  stop(): void;
}

type SpeechRecognitionCtor = new () => {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
};

export class WebSpeechDictation implements Dictation {
  private rec: InstanceType<SpeechRecognitionCtor> | null = null;

  private ctor(): SpeechRecognitionCtor | undefined {
    const w = window as unknown as {
      SpeechRecognition?: SpeechRecognitionCtor;
      webkitSpeechRecognition?: SpeechRecognitionCtor;
    };
    return w.SpeechRecognition || w.webkitSpeechRecognition;
  }

  supported(): boolean {
    return !!this.ctor();
  }

  start(onPartial: (text: string) => void): Promise<string> {
    const Ctor = this.ctor();
    if (!Ctor) return Promise.reject(new Error("speech recognition unavailable"));
    return new Promise<string>((resolve, reject) => {
      const rec = new Ctor();
      this.rec = rec;
      rec.lang = "en-US";
      rec.continuous = true;
      rec.interimResults = true;
      let finalText = "";
      rec.onresult = (e) => {
        let interim = "";
        for (let i = 0; i < e.results.length; i++) {
          const alt = e.results[i][0];
          // Interim and final chunks both arrive; accumulate into one string.
          interim += alt.transcript;
        }
        finalText = interim.trim();
        onPartial(finalText);
      };
      rec.onerror = (ev) => reject(new Error(ev.error || "dictation error"));
      rec.onend = () => resolve(finalText.trim());
      rec.start();
    });
  }

  stop(): void {
    this.rec?.stop();
  }
}
