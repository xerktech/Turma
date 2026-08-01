// Phone-companion bridge (XERK-171) — the plugin-side half of the link between
// the embedded web Sessions/Board pages and the glasses App. The web half is
// turma/public/glasses-embed.js; this is what the Even Hub plugin runs.
//
// Both run in the same WebView, but the embedded page is a cross-origin iframe,
// so they talk over postMessage:
//
//   page  -> plugin : {source:"turma-embed", type:"session-open", host, id}
//                     {source:"turma-embed", type:"org", key}
//                     {source:"turma-embed", type:"ready", page}
//   plugin -> page  : {source:"turma-host",  type:"enter-session", host, id}
//
// Opening a session on the phone enters it on the glasses (session-open ->
// App.enterSession); filtering orgs on the phone scopes the glasses list (org ->
// App.setOrgFilter); entering a session on the glasses opens it on the phone
// (App.onEnterSession -> notifyEnterSession -> the page). LEAVING never crosses:
// the page never emits on back/close and the App only signals genuine enters.
//
// Structural deps only (no SDK, no DOM types) so the whole thing is unit-testable
// with plain fakes, matching the package's pure-core convention.

// The slice of the App this bridge drives. The real App (app.ts) satisfies it.
export interface BridgeApp {
  enterSession(sessionId: string, hostKeyHint?: string): void;
  setOrgFilter(siteKey: string): void;
}

export interface PhoneBridge {
  // Feed it each window "message" event's `.data`. Non-ours / malformed data is
  // ignored, so the caller can wire it to the raw listener without pre-filtering.
  handleMessage(data: unknown): void;
  // Wire as the App's onEnterSession callback — posts the enter to the page so
  // the phone follows the glasses into a session.
  notifyEnterSession(hostKey: string, sessionId: string): void;
}

export const FROM_PAGE = "turma-embed";
export const FROM_HOST = "turma-host";

interface EmbedMsg {
  source?: string;
  type?: string;
  host?: string;
  id?: string;
  key?: string;
}

export function createPhoneBridge(
  app: BridgeApp,
  postToFrame: (msg: unknown) => void
): PhoneBridge {
  return {
    handleMessage(data: unknown): void {
      const m = data as EmbedMsg | null;
      if (!m || m.source !== FROM_PAGE) return;
      if (m.type === "session-open" && m.id) {
        // App.enterSession no-ops when the glasses are already on this session,
        // which is what stops a phone->glasses->phone open from ping-ponging.
        app.enterSession(m.id, m.host);
      } else if (m.type === "org") {
        app.setOrgFilter(m.key || "");
      }
      // "ready" needs no reply: org rides the page's own poll and enters are
      // pushed live; a page mid-reload simply catches the next one.
    },
    notifyEnterSession(hostKey: string, sessionId: string): void {
      if (!sessionId) return;
      postToFrame({ source: FROM_HOST, type: "enter-session", host: hostKey, id: sessionId });
    },
  };
}
