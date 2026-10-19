import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { GoogleGenAI } from '@google/genai';
import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const app = express();
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 10000);
const MAX_TEXT_CHARS = 30000;
const MAX_CHUNK_CHARS = 1600;
const MAX_ACTIVE_JOBS = 2;
const JOB_TTL_MS = 30 * 60 * 1000;
const MODEL = process.env.GEMINI_TTS_MODEL || 'gemini-3.8-flash-tts';
const jobs = new Map();
let activeJobs = 0;

app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      connectSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      fontSrc: ["'self'", 'data:'],
      mediaSrc: ["'self'", 'blob:'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"]
    }
  },
  crossOriginResourcePolicy: { policy: 'same-origin' }
}));
app.use(express.json({ limit: '1mb', strict: true }));
app.get('/', (_req, res) => res.sendFile(path.join(ROOT, 'index.html')));
app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'Voxora AI Voice Studio' }));

const generateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 3,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many generation requests from this connection. Please try again later.' }
});

const VOICES = new Set([
  'Achernar', 'Achird', 'Algenib', 'Algieba', 'Alnilam', 'Aoede',
  'Autonoe', 'Callirrhoe', 'Charon', 'Despina', 'Enceladus', 'Erinome',
  'Fenrir', 'Gacrux', 'Iapetus', 'Kore', 'Laomedeia', 'Leda', 'Orus',
  'Puck', 'Pulcherrima', 'Rasalgethi', 'Sadachbia', 'Sadaltager',
  'Schedar', 'Sulafat', 'Umbriel', 'Vindemiatrix', 'Zephyr', 'Zubenelgenubi'
]);
const STYLES = new Set([
  'Natural, clear and conversational',
  'Warm storytelling narration with expressive phrasing',
  'Calm, gentle and reassuring',
  'Confident, energetic and engaging',
  'Polished professional documentary narration',
  'Friendly, warm and approachable',
  'Dramatic audiobook narration with natural pauses'
]);
const LANGUAGES = new Set(['Bengali', 'English', 'Hindi']);
const SPEEDS = new Set(['slow', 'normal', 'fast']);

function splitLongText(input, max = MAX_CHUNK_CHARS) {
  const paragraphs = input.replace(/\r\n?/g, '\n').split(/\n{2,}/u).map(s => s.trim()).filter(Boolean);
  const pieces = [];
  const pushSmart = (segment) => {
    let rest = segment.trim();
    while (rest.length > max) {
      let cut = Math.max(
        rest.lastIndexOf('. ', max), rest.lastIndexOf('! ', max),
        rest.lastIndexOf('? ', max), rest.lastIndexOf('। ', max),
        rest.lastIndexOf(' ', max)
      );
      if (cut < Math.floor(max * 0.55)) cut = max;
      pieces.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) pieces.push(rest);
  };

  for (const paragraph of paragraphs) {
    const sentences = paragraph.match(/[^.!?।\n]+[.!?।]*/gu) || [paragraph];
    let current = '';
    for (const sentenceRaw of sentences) {
      const sentence = sentenceRaw.trim();
      if (!sentence) continue;
      if (sentence.length > max) {
        if (current) { pieces.push(current.trim()); current = ''; }
        pushSmart(sentence);
        continue;
      }
      if (current.length + sentence.length + 1 > max && current) {
        pieces.push(current.trim());
        current = sentence;
      } else {
        current = current ? `${current} ${sentence}` : sentence;
      }
    }
    if (current.trim()) pieces.push(current.trim());
  }
  return pieces.filter(Boolean);
}

function runFfmpeg(args, cwd) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error('FFmpeg is not available in this environment.'));
    const child = spawn(ffmpegPath, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
    let lastError = '';
    child.stderr.on('data', chunk => {
      lastError = (lastError + chunk.toString()).slice(-5000);
    });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`MP3 conversion failed (code ${code}). ${lastError.slice(-900)}`));
    });
  });
}

function audioGenerationRequest(ai, text, options) {
  const pace = options.speed === 'slow' ? 'slow speaking pace' : options.speed === 'fast' ? 'brisk speaking pace' : 'natural conversational pace';
  const style = `${options.style}. Read the script in ${options.language}. Use a ${pace}. Read the supplied text verbatim; do not add or omit words.`;
  return ai.interactions.create({
    model: MODEL,
    input: [{
      type: 'user_input',
      content: [{
        type: 'text',
        text,
        annotations: [{ type: 'speech_metadata', style }]
      }]
    }],
    response_format: { type: 'audio' },
    generation_config: { speech_config: [{ voice: options.voice }] }
  });
}

async function synthesizeJob(job, options) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('The server owner has not configured GEMINI_API_KEY yet.');
  const ai = new GoogleGenAI({ apiKey });
  const chunks = splitLongText(options.text);
  if (!chunks.length) throw new Error('No readable text was found.');
  job.total = chunks.length;
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'voxora-'));
  job.folder = folder;
  const fileNames = [];

  for (let i = 0; i < chunks.length; i++) {
    job.progress = i;
    job.message = `Generating audio section ${i + 1} of ${chunks.length}…`;
    // Sequential calls keep peak resource use and API burst traffic lower.
    const result = await audioGenerationRequest(ai, chunks[i], options);
    const audioData = result?.output_audio?.data;
    if (!audioData || typeof audioData !== 'string') {
      throw new Error(`The TTS service returned no audio for section ${i + 1}.`);
    }
    const buffer = Buffer.from(audioData, 'base64');
    if (buffer.length < 44 || buffer.subarray(0, 4).toString() !== 'RIFF') {
      throw new Error(`The TTS service returned an unexpected audio format for section ${i + 1}.`);
    }
    const name = `part-${String(i).padStart(4, '0')}.wav`;
    await fs.writeFile(path.join(folder, name), buffer, { flag: 'wx' });
    fileNames.push(name);
    job.progress = i + 1;
  }

  job.message = 'Joining sections and exporting MP3…';
  const concatList = fileNames.map(name => `file '${name}'`).join('\n') + '\n';
  await fs.writeFile(path.join(folder, 'concat.txt'), concatList, 'utf8');
  const output = path.join(folder, 'voiceover.mp3');
  await runFfmpeg([
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'concat', '-safe', '0', '-i', 'concat.txt',
    '-vn', '-ac', '1', '-ar', '24000', '-codec:a', 'libmp3lame',
    '-b:a', '128k', '-f', 'mp3', 'voiceover.mp3'
  ], folder);
  const stats = await fs.stat(output);
  if (!stats.size) throw new Error('The exported MP3 file is empty.');
  job.file = output;
  job.status = 'done';
  job.progress = job.total;
  job.message = 'Your MP3 is ready.';
  job.completedAt = Date.now();

  const cleanupTimer = setTimeout(() => {
    const current = jobs.get(job.id);
    if (current?.folder === folder) jobs.delete(job.id);
    fs.rm(folder, { recursive: true, force: true }).catch(() => {});
  }, JOB_TTL_MS);
  cleanupTimer.unref?.();
}

app.post('/api/generate', generateLimiter, async (req, res) => {
  try {
    const body = req.body ?? {};
    if (typeof body.text !== 'string' || !body.text.trim()) {
      return res.status(400).json({ error: 'Please enter some text first.' });
    }
    const text = body.text.trim();
    if (text.length > MAX_TEXT_CHARS) {
      return res.status(413).json({ error: `This version accepts up to ${MAX_TEXT_CHARS.toLocaleString()} characters per generation.` });
    }
    if (!VOICES.has(body.voice)) return res.status(400).json({ error: 'Please select a supported voice.' });
    if (activeJobs >= MAX_ACTIVE_JOBS) return res.status(429).json({ error: 'The studio is busy generating other audio. Please retry in a minute.' });

    const options = {
      text,
      voice: body.voice,
      style: STYLES.has(body.style) ? body.style : 'Natural, clear and conversational',
      speed: SPEEDS.has(body.speed) ? body.speed : 'normal',
      language: LANGUAGES.has(body.language) ? body.language : 'Bengali'
    };
    const job = {
      id: crypto.randomUUID(), status: 'processing', progress: 0,
      total: 0, message: 'Starting voice generation…', createdAt: Date.now(),
      file: null, folder: null
    };
    jobs.set(job.id, job);
    activeJobs++;
    res.status(202).json({ jobId: job.id });
    synthesizeJob(job, options).catch(async error => {
      console.error(`[job ${job.id}]`, error?.stack || error);
      job.status = 'error';
      job.message = error?.message?.startsWith('The server owner')
        ? error.message
        : 'Voice generation failed. Check the Gemini API setup, model access and Render logs.';
      job.progress = 0;
      if (job.folder) await fs.rm(job.folder, { recursive: true, force: true }).catch(() => {});
      job.file = null;
      // Failed jobs must not accumulate forever in the in-memory job registry.
      const cleanupTimer = setTimeout(() => jobs.delete(job.id), JOB_TTL_MS);
      cleanupTimer.unref?.();
    }).finally(() => { activeJobs = Math.max(0, activeJobs - 1); });
  } catch (error) {
    console.error('Request handling error:', error);
    if (!res.headersSent) res.status(500).json({ error: 'The server could not start the audio job.' });
  }
});

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'This job expired or could not be found.' });
  return res.json({ status: job.status, progress: job.progress, total: job.total, message: job.message });
});

app.head('/api/jobs/:id/download', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== 'done' || !job.file) return res.status(404).end();
  return res.status(200).set({ 'Content-Type': 'audio/mpeg' }).end();
});

app.get('/api/jobs/:id/download', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'This audio has expired or could not be found.' });
  if (job.status !== 'done' || !job.file) return res.status(409).json({ error: 'The MP3 is not ready yet.' });
  const isDownload = req.query.download === '1';
  res.type('audio/mpeg');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Disposition', `${isDownload ? 'attachment' : 'inline'}; filename="voxora-voiceover.mp3"`);
  return res.sendFile(job.file, error => {
    if (error && !res.headersSent) res.status(error.statusCode || 500).end();
  });
});

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'API endpoint not found.' });
  return res.status(404).send('Not found.');
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Voxora AI Voice Studio listening on port ${PORT}`);
});
