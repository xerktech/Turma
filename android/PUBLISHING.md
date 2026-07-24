# Publishing the Turma Android app to Google Play

This is a step-by-step walkthrough for taking the app that today ships as a
**sideloaded APK** (GitHub releases + the in-app updater, XERK-11) and putting it
on the **Google Play Store**.

Read the whole "Before you start" section first: this repo is wired for the
sideload path, and **three things about it are incompatible with a Play build**.
Those must be fixed in the code/CI before an upload will pass review, so they come
before the Play Console clicking.

---

## Before you start — what has to change in the repo

### 1. Play wants an App Bundle (`.aab`), not an APK

`release.yml`'s `build-android` job runs `gradle :app:assembleRelease` and ships
`turma-android-v<version>.apk`. That APK is what the in-app updater sideloads, and
it stays exactly as it is.

Play, however, requires an **Android App Bundle** for a new app. You produce one
with a different Gradle task against the same module:

```bash
cd android
gradle :app:bundleRelease --no-daemon --stacktrace
# → app/build/outputs/bundle/release/app-release.aab
```

You can build both from one release: keep `assembleRelease` for the sideload APK
and add `bundleRelease` for the Play AAB. See "Automating it in CI" at the end.

### 2. The in-app self-updater must be removed from the Play build (policy blocker)

`AndroidManifest.xml` declares `REQUEST_INSTALL_PACKAGES`, and `core.Update` /
`net.Updater` download a newer APK from GitHub and hand it to the system installer
(`ui.UpdateBanner`, the `${applicationId}.updates` `FileProvider`).

Google Play's **Device and Network Abuse** policy prohibits an app distributed
through Play from updating, modifying, or replacing itself by any method other than
Play's own update mechanism. An app that pulls an APK and installs it fails review.
`REQUEST_INSTALL_PACKAGES` also triggers a sensitive-permission declaration you'd
have no approvable justification for.

**The Play build must not contain the updater or that permission.** The clean way,
because the sideload build still needs both, is a Gradle **product flavor** so one
module produces two artifacts:

- `sideload` flavor → keeps `REQUEST_INSTALL_PACKAGES`, the `FileProvider`, and the
  `UpdateBanner`; this is what `assembleRelease` builds for GitHub releases.
- `play` flavor → strips all three; this is what `bundleRelease` builds for Play.

Sketch (in `app/build.gradle.kts`; adjust to taste):

```kotlin
android {
    flavorDimensions += "distribution"
    productFlavors {
        create("sideload") { dimension = "distribution" }  // default behavior today
        create("play")     { dimension = "distribution" }  // no self-update
    }
}
```

Then:

- Put `REQUEST_INSTALL_PACKAGES`, the `<provider>` block, and `@xml/file_paths` in a
  **`sideload`-only** source set (`app/src/sideload/AndroidManifest.xml` +
  `app/src/sideload/res/`), leaving `app/src/main/AndroidManifest.xml` free of them.
- Move `core/Update.kt`, `net/Updater.kt`, `ui/UpdateBanner.kt`, and
  `vm/UpdateViewModel.kt` into `app/src/sideload/…`, and have the Dashboard mount the
  update banner only in that flavor (a small no-op stub in `app/src/play/…`, or a
  `BuildConfig.FLAVOR` guard).
- Build tasks become flavor-qualified: `assembleSideloadRelease` (the APK) and
  `bundlePlayRelease` (the AAB). Update `release.yml` accordingly.

A lighter alternative — a single build with the updater compiled in but disabled on
Play — is **not** enough: the offending part is the manifest permission and the
install capability, which a runtime flag doesn't remove. Reviewers scan the
manifest. Use source-set separation.

> While you're in there: `RECORD_AUDIO` (voice dictation) is a sensitive permission.
> It's legitimate, but Play's Data safety form and possibly a permissions declaration
> will ask you to justify it — have "voice input for starting/answering sessions"
> ready. See "Data safety" below.

### 3. The signing story changes: upload key vs. app signing key

Today the release APK is signed with **`app/turma-release.keystore`**, a keystore
committed to the repo with the password in plain sight (`turma-release`). That is
deliberate and fine for sideload: its only job is to be identical on every CI runner
so in-place updates work (XERK-26), and the app only installs official HTTPS
releases.

For Play you use **Play App Signing**, which splits the key in two:

- **App signing key** — the key Google uses to sign the APKs it actually serves to
  devices. Google generates and custody-holds it (recommended). This becomes the
  app's permanent identity; you can never change it.
- **Upload key** — the key *you* sign the AAB with before uploading. Google verifies
  it, strips it, and re-signs with the app signing key. If your upload key is ever
  compromised you can rotate it; the app signing key is unaffected.

**Do not use the committed `turma-release.keystore` as your upload key** — its
password is public, so anyone could forge an upload. Generate a fresh, private
upload key and keep it out of the repo:

```bash
keytool -genkeypair -v \
  -keystore turma-upload.jks \
  -alias turma-upload \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -storetype JKS
# Choose a strong password. Store the keystore + password in a secret manager,
# and (for CI) as base64 in GitHub Actions secrets. NEVER commit it.
```

Because the `play` flavor is Play-only, wire its signing to read the upload key from
secrets, not from the committed file:

```kotlin
signingConfigs {
    create("upload") {
        storeFile = System.getenv("UPLOAD_KEYSTORE")?.let { file(it) }
        storePassword = System.getenv("UPLOAD_KEYSTORE_PASSWORD")
        keyAlias = System.getenv("UPLOAD_KEY_ALIAS")
        keyPassword = System.getenv("UPLOAD_KEY_PASSWORD")
    }
}
// …
productFlavors {
    getByName("play") { /* … */ }
}
buildTypes {
    release {
        // sideload keeps signingConfigs["release"] (turma-release.keystore);
        // play uses the upload key. Select per-variant, e.g. in
        // androidComponents.onVariants, or split release build types per flavor.
    }
}
```

Keep a **secure, offline backup of the upload keystore and its password.** Losing the
upload key is recoverable (Google can reset it); the point is not to leak it.

---

## The rest is Google Play Console — mostly one-time

### 4. Create (or use) a Google Play Developer account

1. Go to <https://play.google.com/console> and sign in with the Google account that
   should own the listing (ideally an org/shared account, not a personal one).
2. Pay the **one-time \$25** registration fee.
3. Choose the account type:
   - **Organization** (for XerkTech) — needs a website, a contact, and a **D-U-N-S
     number** for the legal entity (free to request from Dun & Bradstreet; can take a
     few days). Recommended for a company app.
   - **Personal** — faster, but personal accounts created after Nov 13 2023 must run
     a **closed test with at least 20 testers for 14 continuous days** before Google
     will unlock production access. Budget for that timeline.
4. Complete identity/contact verification if prompted.

### 5. Create the app in the console

1. **All apps → Create app.**
2. App name: e.g. *Turma*. Default language, app-or-game (App), free/paid (Free).
3. Accept the developer program + US export declarations.
4. This reserves the package name once you first upload — it must be
   **`com.xerktech.turma`** (matches `applicationId`). A package name on Play is
   permanent, so make sure it's the one you want.

### 6. Turn on Play App Signing and register the upload key

1. In the new app: **Release → Setup → App signing.**
2. Let Google **generate and manage the app signing key** (recommended).
3. Your first uploaded AAB's upload certificate is registered as the **upload key**
   automatically. (You can instead pre-register it, or later rotate it, from this
   screen.) This is the key from step 3 above — *not* `turma-release.keystore`.

### 7. Fill in the mandatory store listing & policy declarations

Play won't let you release to production until these are green (**Dashboard →
"Set up your app"** walks the same list):

- **Store listing** — short + full description, app icon (512×512), feature graphic
  (1024×500), at least 2–8 phone screenshots (and tablet/foldable shots, since the
  app has an adaptive two-pane layout — good to show it off), category, contact email.
- **Privacy policy URL** — required, because the app handles personal/sensitive data
  (audio for voice, stored hub credentials, an FCM device token). Host a real policy
  page and link it.
- **Data safety** — declare what's collected/shared and why. For this app that's at
  least: audio (voice dictation, processed transient), credentials (hub login, stored
  encrypted on-device via `security-crypto`), and an FCM push token. Be honest about
  on-device vs. transmitted. Nothing is sold or shared with third parties.
- **App content / content rating** — complete the IARC questionnaire (a dev/utility
  tool rates low).
- **Target audience & content** — not directed at children.
- **Ads** — declare "no ads."
- **Government apps / financial / health** — N/A.
- **News app** — N/A.
- **Permissions** — if any sensitive permission needs a declaration form, justify it.
  With the updater removed there should be no `REQUEST_INSTALL_PACKAGES`; `RECORD_AUDIO`
  is justified as voice input. Confirm no `MANAGE_EXTERNAL_STORAGE` or similar sneaks in.
- **Target API level** — Play requires new apps to target a recent API. The app is
  `targetSdk = 35` (Android 15), which satisfies the current requirement.

### 8. Build the Play AAB and do the first upload via a test track

Always ship to a **testing track first**, never straight to production.

1. Build the signed Play bundle (once the flavor/signing from steps 2–3 exist):
   ```bash
   cd android
   UPLOAD_KEYSTORE=/secure/path/turma-upload.jks \
   UPLOAD_KEYSTORE_PASSWORD=… UPLOAD_KEY_ALIAS=turma-upload UPLOAD_KEY_PASSWORD=… \
   TURMA_VERSION=<x.y.z> TURMA_VERSION_CODE=<packed> \
   gradle :app:bundlePlayRelease --no-daemon --stacktrace
   # → app/build/outputs/bundle/playRelease/app-play-release.aab
   ```
   Use the same `TURMA_VERSION` / `TURMA_VERSION_CODE` the unified release computes
   (`.github/scripts/version.js`; the code is `major*1_000_000 + minor*10_000 + patch`,
   already monotonic — exactly what Play requires).
2. **Release → Testing → Internal testing → Create new release.**
3. Upload the `.aab`. Add release notes. Save → Review → **Start rollout to Internal
   testing.**
4. Add your Google account to the internal testers list, open the opt-in link on a
   device, install from Play, and verify: sign-in, live sessions, push
   (`google-services.json` is committed so the CI/Play build carries FCM), voice,
   the adaptive two-pane layout — and that **no update banner appears** (it's the
   sideload flavor's, gone from the Play build).

### 9. Promote through tracks, then production

- **Internal → Closed testing** (a small invited group; also where the "20 testers /
  14 days" requirement is satisfied on a personal account) **→ Open testing** (public
  beta, optional) **→ Production.**
- For production: **Release → Production → Create new release**, upload (or promote the
  same AAB), set the **staged rollout** percentage (start at, say, 20%), and submit for
  review. First reviews can take a few days.
- Watch **Release → Reviews** and **Quality → Android vitals** (crashes/ANRs) as you
  ramp the rollout to 100%.

---

## After the first release

- **Every subsequent upload needs a strictly higher `versionCode`.** The packed code
  from `version.js` handles this automatically as long as versions keep climbing —
  never reuse a code Play has already seen.
- **The in-app updater is now redundant *for Play users*** and is gone from the Play
  flavor. The `sideload` flavor keeps it for anyone installing the GitHub-release APK
  directly. If you eventually make Play the only channel, retire XERK-11 entirely (and
  the `native` agent updater is unrelated — it updates the host agent, not this app).
- **Keep the upload keystore backed up and private.** If it leaks or is lost, reset it
  from **App signing** in the console; the app signing key (the device-facing identity)
  is unaffected either way.
- **Migrating existing sideload users to the Play build is a fresh install**, not an
  in-place update: the Play build is signed (by Google) with a different certificate
  than `turma-release.keystore`, so an installed sideload copy can't be updated over
  the top — users uninstall the sideloaded app and install from Play once. (Same class
  of one-time break as the XERK-26 stable-key cutover.)

## Automating it in CI (optional, after the manual first release)

Once the manual flow works, extend `.github/workflows/release.yml`'s `build-android`
job to also build and publish the Play bundle:

- Add a step running `gradle :app:bundlePlayRelease`, with the upload keystore
  provided from a base64 GitHub Actions secret (decoded to a temp file) and the
  passwords/alias from secrets — never from the repo.
- Upload to Play with an action such as `r0adkll/upload-google-play` (or the Google
  Play Developer API directly), authenticated by a **service account** JSON you create
  in the Google Cloud project linked to the Play Console (**Setup → API access**), with
  the account granted release permissions. Store that JSON as a secret.
- Target the `internal` track from CI and promote by hand in the console, so a bad
  build can't auto-hit production.

Keep the existing `assembleRelease` (sideload APK → GitHub release) step as-is; the
two artifacts coexist.
