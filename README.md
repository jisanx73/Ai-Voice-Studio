# Voxora AI Voice Studio — premium UI refresh

A mobile-first text-to-speech studio with a single-file frontend and a Node.js backend using Google's Gemini TTS API.

## Files
- `index.html` — complete responsive frontend (HTML, CSS and JavaScript in one file). Includes a 30-voice library, search, All/Female/Male filters, Bengali/English/Hindi selection, script import, progress, recent project list, audio playback and MP3 download.
- `server.js` — server-side Gemini TTS calls, voice/style validation, long-text chunking, job progress, temporary WAV storage, FFmpeg MP3 export and API endpoints.
- `package.json` — Node.js dependencies and start command.
- `render.yaml` — Render Blueprint starter configuration.

## Deploy on Render from GitHub
1. Upload the extracted project files into the root of your `ai-voice-studio` repository; don't upload only the ZIP.
2. In Render choose **New → Web Service**, connect the repository, then configure:
   - Runtime: Node
   - Build command: `npm install`
   - Start command: `npm start`
3. Add environment variable `GEMINI_API_KEY` using a key created in Google AI Studio. Never put the key in `index.html` or commit it to GitHub.
4. Deploy and check `https://YOUR-SERVICE.onrender.com/api/health` returns `{ "ok": true, ... }`.

## Important limits and behaviour
- This version accepts up to 30,000 characters per job and chunks long input into smaller TTS requests. It is not unlimited; model availability, API quota, billing, Render limits and processing time still apply.
- Generated MP3s are stored temporarily in the running service and deleted after 30 minutes. A restart or redeploy can also remove temporary jobs. Permanent audio storage needs object storage and a database.
- Browser-side recent history is stored locally and links to temporary server jobs, so older downloads can expire.
- The client Owner Admin Panel, secure user login, permanent user accounts and payment controls have not been implemented yet.
- Google Gemini TTS provides 30 named prebuilt voice presets with style descriptors. Female/Male UI tags are a convenience based on Google's published Chirp 3 HD voice catalog with matching names; they are not a guarantee of the exact rendered sound in every Gemini model/language combination. Test the output for the chosen language before offering it to customers.
- Helmet's Content Security Policy allows this one-file app's inline JS/CSS while keeping API calls same-origin. Keep the API key only in server environment variables.
