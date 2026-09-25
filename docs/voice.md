# Voice input (speech-to-text)

pi-ui can turn spoken audio into text in the prompt bar: click the microphone button next
to the Files (paperclip) button, or press <kbd>alt</kbd> <kbd>v</kbd>, speak, then press
Done (or <kbd>enter</kbd>). The recording is sent to
[Groq](https://console.groq.com)'s Whisper transcription API and the transcript is
inserted into your draft at the caret — nothing is sent automatically, you still review
and press Send yourself.

There is no local speech-to-text model and no bundled encoder: the browser records with
`MediaRecorder` (Opus in WebM/Ogg, or AAC in MP4 on older Safari) and uploads that
compressed audio as-is to the pi-ui server, which forwards it to Groq. Audio is never
written to disk and transcripts are never logged.

## Requirements

1. **A Groq API key** available to the pi-ui **server** process (not the browser — see
   [Where the key lives](#where-the-key-lives) below).
2. **A secure context.** The browser's microphone API only works on `https://` origins,
   or on `localhost`/`127.0.0.1`. See [HTTPS and remote access](#https-and-remote-access).
3. A browser with `MediaRecorder` and `getUserMedia` support — every current desktop and
   mobile browser qualifies (Chrome, Edge, Firefox, Safari 14.1+).

If either requirement isn't met, the microphone button stays visible but dimmed
(`opacity: 0.5`), and clicking it explains why instead of prompting for the microphone.

## Where the key lives

pi-ui looks for a Groq key in two places, in order, **on the server**:

1. **`GROQ_API_KEY`** in the server process's environment. This is the primary source —
   it's the same variable pi's own SDK already recognizes for Groq, so one key can serve
   both pi chat and voice input.
2. Otherwise, a `groq` credential in pi's own `~/.pi/agent/auth.json` (an
   `api_key`-type entry; a Groq **OAuth** login there, if pi ever adds one, is ignored).
   This is read fresh on each page load and each transcription, so adding a key to
   `auth.json` takes effect after a browser reload — no server restart needed. A key
   supplied via `GROQ_API_KEY` does need a restart to change.

**There is no field in the pi-ui UI or in `~/.config/pi-ui/config.json` to paste a Groq
key.** That's deliberate: `config.json` has no encryption, and on a shared or remote
install it can be more reachable than the server's own environment or pi's credential
store. The key never reaches the browser — the client only ever sees
`data-voice-status="ready" | "no-key" | "disabled"` on `<body>`.

To set the key, either export it for the server process:

```sh
export GROQ_API_KEY=gsk_...
pi-ui
```

or store it in pi itself: run `/login groq` inside pi and choose the API-key method,
which saves it to `~/.pi/agent/auth.json`. pi-ui then picks it up on the next page load.

If neither is present, the mic button is blocked with "Voice input needs a Groq API key.
Set `GROQ_API_KEY` for the pi-ui server (or add a Groq key to pi), then reload." and the
server answers `POST /voice/transcribe` with `503 {"error":"not-configured"}`.

## HTTPS and remote access

The microphone check is deterministic and client-side:
`window.isSecureContext && navigator.mediaDevices?.getUserMedia && window.MediaRecorder`.
Concretely:

| Where you open pi-ui                                 | Works?                                                                                            |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `http://localhost:31415` or `http://127.0.0.1:31415` | Yes — localhost is a secure context by spec, even over plain HTTP                                 |
| `http://192.168.x.x:31415` (LAN IP, plain HTTP)      | **No.** Every standards-compliant browser refuses `getUserMedia` on an insecure, non-local origin |
| `https://<host>.<tailnet>.ts.net` (Tailscale Serve)  | Yes, on desktop and phones                                                                        |
| Behind Cloudflare Tunnel+Access or Caddy+TLS         | Yes                                                                                               |

If you're reaching pi-ui over your LAN by plain HTTP today, put it behind HTTPS the same
way [`docs/remote.md`](remote.md#network-exposure--pick-one) already recommends for
remote access generally — `tailscale serve` is the fastest path and needs no pi-ui
configuration change. See [`docs/remote.md`](remote.md) for Cloudflare Tunnel and Caddy
alternatives.

For local development only, Chromium-family browsers accept a flag that treats one
insecure origin as secure:

```sh
chrome --unsafely-treat-insecure-origin-as-secure=http://192.168.0.158:31415
```

**This is a dev-only escape hatch.** It weakens the browser's own security model for that
origin in that browser profile; don't rely on it for anything but testing on your own
machine. pi-ui itself does not implement TLS termination — see
[`docs/remote.md`](remote.md) for that.

If the origin isn't secure, the mic is blocked with: "Voice input needs a secure
connection. Open pi-ui over HTTPS (for example your Tailscale `https://…ts.net` address)
or on localhost." `getUserMedia` is never called in this case — there's no permission
prompt to dismiss.

## Using it

- Click the mic (or <kbd>alt</kbd> <kbd>v</kbd>) to start. The prompt bar briefly shows
  "Starting microphone…" (and "Allow microphone access…" if the browser's permission
  prompt is up), then a red dot, a running timer and a live waveform replace the prompt
  textarea.
- The pause button pauses; press it again (it shows a play icon while paused) to
  resume. Recording auto-pauses if you switch tabs or lock the screen, and resumes only
  when you ask it to.
- Press Done (✓), <kbd>enter</kbd> or <kbd>alt</kbd> <kbd>v</kbd> again to finish. The
  recording stops immediately, the
  microphone is released (so your browser's recording indicator goes away) before the
  upload starts, and the panel shows "Transcribing…".
- Press <kbd>esc</kbd> or ✕ at any point to cancel — nothing is uploaded and your draft
  is unchanged. While voice input is active, <kbd>esc</kbd> cancels the recording instead
  of aborting a running agent turn.
- The transcript lands at the caret (replacing a selection, if you had one), with a
  single space added where needed. It is never sent for you — edit it like anything
  else you typed, then press Send or <kbd>enter</kbd>.
- Recording stops automatically at the configured time limit (`voice.maxSeconds`, 5
  minutes by default), with a warning color on the timer in the last 15 seconds.
- If nothing intelligible was captured (near-silence, a very short take), you'll see
  "Didn't catch any speech. Try again closer to the microphone." instead of an upload —
  your draft is untouched either way.

## Configuration

All fields live under `voice` in `~/.config/pi-ui/config.json` (`%APPDATA%\pi-ui\config.json`
on Windows) and are optional — defaults shown:

```json
{
	"voice": {
		"enabled": true,
		"model": "whisper-large-v3-turbo",
		"language": "",
		"prompt": "",
		"removeFillerWords": true,
		"maxSeconds": 300,
		"baseUrl": "https://api.groq.com/openai/v1"
	}
}
```

| Field               | Default                          | Notes                                                                                                                                                                                                                                                                                              |
| ------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`           | `true`                           | `false` hides the mic button entirely (`data-voice-status="disabled"`); `POST /voice/transcribe` answers `404`.                                                                                                                                                                                    |
| `model`             | `"whisper-large-v3-turbo"`       | Any Groq speech-to-text model id. `turbo` is the cheapest and fastest; the accuracy difference versus larger Whisper models is immaterial for everyday dictation.                                                                                                                                  |
| `language`          | `""` (auto-detect)               | An ISO-639-1 code (e.g. `"en"`) pins the language and is slightly faster/more accurate for consistently single-language dictation. Leave empty to auto-detect, which handles mixed-language speech.                                                                                                |
| `prompt`            | `""`                             | A short vocabulary/spelling hint (product names, jargon) sent with every transcription, up to 896 characters.                                                                                                                                                                                      |
| `removeFillerWords` | `true`                           | Strip filler sounds ("hmm", "hmmm", "uh", "uhm", "mmm"; also "um", "ah", "eh", "erm" when the audio is English) and 3+ word stutters from each transcript, as Handy does. English-only fillers need `language: "en"` or Whisper detecting English, because "um" is a real word in other languages. |
| `maxSeconds`        | `300`                            | 10–1800. Recording finishes automatically at this length.                                                                                                                                                                                                                                          |
| `baseUrl`           | `https://api.groq.com/openai/v1` | An OpenAI-compatible transcription endpoint. Overriding this only makes sense for testing against a local fixture server — Groq is the only provider pi-ui's error handling is tuned for.                                                                                                          |

pi-ui reads `voice.*` once, when the server starts, so restart the server after changing
it (then reload the page). A Groq key added to pi's `auth.json` is the exception: it is
picked up on the next page load without a restart.

## Per-browser notes

- **Chrome, Edge, Firefox** (desktop and Android): full support, records Opus in WebM
  (or Ogg on Firefox).
- **Safari 18.4+** (macOS and iOS): records Opus in WebM like Chromium.
- **Safari 18.3 and earlier**: `audio/webm` isn't supported, so pi-ui falls back to AAC in
  an MP4 container — this is handled automatically, no configuration needed.
- **iOS / installed PWA**: recording auto-pauses when the app is backgrounded or the
  screen locks (iOS suspends microphone capture in the background). Resume it manually
  when you come back; nothing recorded before the pause is lost.
- **Insecure origins** (see above): the button is visibly dimmed and never triggers the
  permission prompt.

## Troubleshooting

| Symptom                                                      | Likely cause                                                            | Fix                                                                                                                                      |
| ------------------------------------------------------------ | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Mic button is missing                                        | `voice.enabled: false`                                                  | Remove the setting, or set it to `true`, in `config.json`, then restart the server.                                                      |
| Mic button is dimmed, clicking shows an HTTPS message        | Insecure origin                                                         | See [HTTPS and remote access](#https-and-remote-access).                                                                                 |
| Mic button is dimmed, clicking shows "needs a Groq API key"  | No key resolved on the server                                           | See [Where the key lives](#where-the-key-lives). Reload after adding a key.                                                              |
| "Microphone access is blocked…"                              | The browser or OS denied mic permission                                 | Allow the microphone for this site in your browser's site settings (and check the OS-level app permission on macOS/Windows), then retry. |
| "No microphone found."                                       | No audio input device                                                   | Check the OS sees a microphone; plug one in or unmute it.                                                                                |
| "The microphone is busy or unavailable…"                     | Another app has an exclusive hold on the mic                            | Close the other app (or its call/meeting) and retry.                                                                                     |
| "Groq rejected the API key…"                                 | `GROQ_API_KEY` (or pi's Groq key) is invalid, revoked, or missing scope | Check the key on [console.groq.com](https://console.groq.com), update it, restart the server if it came from the environment.            |
| "Recording is too large for Groq (25 MB)…"                   | A very long or high-bitrate recording                                   | Record a shorter take, or lower `voice.maxSeconds`.                                                                                      |
| "Groq rate limit reached…"                                   | Too many transcriptions in a short window                               | Wait the number of seconds shown, then retry (a Retry button appears).                                                                   |
| "Groq is having trouble right now…" / "Couldn't reach Groq…" | A transient Groq outage or the server's own network                     | Retry in a moment — pi-ui already retries once internally before surfacing this.                                                         |
| "Another transcription is still running…"                    | Two transcriptions were in flight at once (pi-ui caps this at 2)        | Wait for the other one to finish, then retry.                                                                                            |
| "Didn't catch any speech…"                                   | The recording was silent, too short, or too quiet                       | Move closer to the microphone and make sure it isn't muted.                                                                              |
| Waveform never appears / "No audio from the microphone…"     | The selected input device is producing digital silence                  | Check the OS's input device and level, then retry.                                                                                       |

## Privacy

Audio you record is sent only to the Groq endpoint configured in `voice.baseUrl` — never
anywhere else, and never used for anything other than that one transcription request.
pi-ui does not write the audio to disk, does not log its contents, and does not log the
transcript; only request metadata (size, duration, status) may appear in server logs, and
the API key itself is never logged or sent to the browser.

## Not supported yet

Streaming partial transcripts, an in-app device picker, translation, and client-side
silence trimming are intentionally out of scope for now — see the design notes if you're
extending this.
