import { describe, expect, it, vi } from "vitest";
import { HubAudioDictation, buildAudioWsUrl, type DictationResult } from "./dictation.ts";
import type { AudioRecorderLike, AudioResultMessage } from "./audio.ts";
import type { HubClient } from "./hub-client.ts";

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function fakeHubClient(overrides: Partial<Pick<HubClient, "wsToken">> = {}): Pick<HubClient, "wsToken"> {
  return {
    wsToken: vi.fn(async () => ({ token: "tok-123", expiresInSec: 300 })),
    ...overrides,
  };
}

function fakeRecorder(overrides: Partial<AudioRecorderLike> = {}): AudioRecorderLike & {
  startCalls: string[];
  stopCalls: number;
  cancelCalls: number;
} {
  const startCalls: string[] = [];
  let stopCalls = 0;
  let cancelCalls = 0;
  return {
    startCalls,
    get stopCalls() {
      return stopCalls;
    },
    get cancelCalls() {
      return cancelCalls;
    },
    async start(url: string) {
      startCalls.push(url);
    },
    async stopAndFinalize(): Promise<AudioResultMessage> {
      stopCalls++;
      return { type: "audio_result", transcript: { text: "" } };
    },
    async cancel() {
      cancelCalls++;
    },
    ...overrides,
  };
}

describe("buildAudioWsUrl", () => {
  it("maps https -> wss and appends /audio?auth=<token>", () => {
    expect(buildAudioWsUrl("https://hub.example.com", "abc")).toBe("wss://hub.example.com/audio?auth=abc");
  });

  it("maps http -> ws", () => {
    expect(buildAudioWsUrl("http://localhost:8300", "abc")).toBe("ws://localhost:8300/audio?auth=abc");
  });

  it("strips a trailing slash on the hub URL before appending the path", () => {
    expect(buildAudioWsUrl("https://hub.example.com/", "abc")).toBe("wss://hub.example.com/audio?auth=abc");
  });

  it("URL-encodes the token", () => {
    expect(buildAudioWsUrl("https://hub.example.com", "a b/c")).toBe("wss://hub.example.com/audio?auth=a%20b%2Fc");
  });
});

describe("HubAudioDictation", () => {
  it("token fetch failure delivers an unavailable result and never opens a WS (recorder.start not called)", async () => {
    const hubClient = fakeHubClient({ wsToken: vi.fn(async () => { throw new Error("hub unreachable"); }) });
    const recorder = fakeRecorder();
    const dictation = new HubAudioDictation({ hubClient, recorder, hubUrl: "https://hub.example.com" });

    const results: DictationResult[] = [];
    dictation.start((r) => results.push(r));
    await flushMicrotasks();

    expect(results).toEqual([{ text: "", unavailable: true, reason: "ws token fetch failed: hub unreachable" }]);
    expect(recorder.startCalls).toEqual([]);
  });

  it("derives the WS URL from the configured hubUrl (https -> wss) and passes the fetched token", async () => {
    const hubClient = fakeHubClient({ wsToken: vi.fn(async () => ({ token: "my-token", expiresInSec: 300 })) });
    const recorder = fakeRecorder();
    const dictation = new HubAudioDictation({ hubClient, recorder, hubUrl: "https://hub.example.com" });

    dictation.start(() => {});
    await flushMicrotasks();

    expect(recorder.startCalls).toEqual(["wss://hub.example.com/audio?auth=my-token"]);
  });

  it("derives ws:// for an http hubUrl", async () => {
    const hubClient = fakeHubClient();
    const recorder = fakeRecorder();
    const dictation = new HubAudioDictation({ hubClient, recorder, hubUrl: "http://localhost:8300" });

    dictation.start(() => {});
    await flushMicrotasks();

    expect(recorder.startCalls).toEqual(["ws://localhost:8300/audio?auth=tok-123"]);
  });

  it("recorder.start (mic/connect) failure delivers an unavailable result", async () => {
    const hubClient = fakeHubClient();
    const recorder = fakeRecorder({
      start: async () => {
        throw new Error("mic busy");
      },
    });
    const dictation = new HubAudioDictation({ hubClient, recorder, hubUrl: "https://hub.example.com" });

    const results: DictationResult[] = [];
    dictation.start((r) => results.push(r));
    await flushMicrotasks();

    expect(results).toEqual([{ text: "", unavailable: true, reason: "mic/connect failed: mic busy" }]);
  });

  it("stop() maps a successful audio_result to a DictationResult and delivers it via onResult", async () => {
    const hubClient = fakeHubClient();
    const recorder = fakeRecorder({
      stopAndFinalize: async () => ({
        type: "audio_result",
        transcript: { text: "deploy the hotfix" },
        durationMs: 2200,
        bytes: 4000,
      }),
    });
    const dictation = new HubAudioDictation({ hubClient, recorder, hubUrl: "https://hub.example.com" });

    const results: DictationResult[] = [];
    dictation.start((r) => results.push(r));
    await flushMicrotasks();

    dictation.stop();
    await flushMicrotasks();

    expect(results).toEqual([{ text: "deploy the hotfix", unavailable: undefined, reason: undefined, durationMs: 2200 }]);
  });

  it("stop() passes through an unavailable/reason transcript from the hub (e.g. Whisper disabled or timeout)", async () => {
    const hubClient = fakeHubClient();
    const recorder = fakeRecorder({
      stopAndFinalize: async () => ({
        type: "audio_result",
        transcript: { text: "", unavailable: true, reason: "whisper not configured" },
      }),
    });
    const dictation = new HubAudioDictation({ hubClient, recorder, hubUrl: "https://hub.example.com" });

    const results: DictationResult[] = [];
    dictation.start((r) => results.push(r));
    await flushMicrotasks();
    dictation.stop();
    await flushMicrotasks();

    expect(results).toEqual([{ text: "", unavailable: true, reason: "whisper not configured", durationMs: undefined }]);
  });

  it("cancel() calls recorder.cancel() and delivers no result — ever, even if stop() would have", async () => {
    const hubClient = fakeHubClient();
    const recorder = fakeRecorder();
    const dictation = new HubAudioDictation({ hubClient, recorder, hubUrl: "https://hub.example.com" });

    const results: DictationResult[] = [];
    dictation.start((r) => results.push(r));
    await flushMicrotasks();

    dictation.cancel();
    await flushMicrotasks();

    expect(recorder.cancelCalls).toBe(1);
    expect(results).toEqual([]);
  });

  it("cancel() suppresses a connect failure's unavailable delivery that was already in flight", async () => {
    const hubClient = fakeHubClient({
      wsToken: () =>
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error("slow failure")), 5);
        }),
    });
    const recorder = fakeRecorder();
    const dictation = new HubAudioDictation({ hubClient, recorder, hubUrl: "https://hub.example.com" });

    const results: DictationResult[] = [];
    dictation.start((r) => results.push(r));
    dictation.cancel(); // fires before the token promise has even rejected
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(results).toEqual([]);
  });
});
