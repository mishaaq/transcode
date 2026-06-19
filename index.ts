import express, { Request, Response } from 'express';
import fs from 'fs';
import multer from 'multer';
import path from 'path';
import { spawn } from 'child_process';

const app = express();
const PORT = Number(process.env.PORT) || 3000;

const command = "ffmpeg -hwaccel vaapi -hwaccel_output_format vaapi -i {input_file} -vf 'scale_vaapi=format=p010' -c:v hevc_vaapi -profile:v 2 -rc_mode CQP -global_quality 24 -c:a aac -f mp4 -movflags frag_keyframe+empty_moov -bsf:a aac_adtstoasc -";

const storage = multer.diskStorage({
  filename: (_req, file, cb) => {
    const timestamp = Date.now();
    const ext = path.extname(file.originalname) || '.mp4';
    cb(null, `${timestamp}-${file.fieldname}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: Infinity,
  },
});

app.get('/', (_req: Request, res: Response) => {
  res.send('Transcode is running!');
});

app.post('/transcode', upload.single('file'), (req: Request, res: Response) => {
  const inputFile = req.file;

  if (!inputFile) {
    res.status(400).json({
      error: 'No file uploaded.',
    });
    return;
  }

  const originalFileName = inputFile.originalname || 'output.mp4';
  const originalBaseName = path.parse(originalFileName).name || 'output';
  const attachmentFileName = `${originalBaseName}-out.mp4`;
  const filePath = inputFile.path;
  const commandToRun = command.replace('{input_file}', filePath);

  const cleanupUploadedFile = () => {
    fs.unlink(filePath, (err) => {
      if (err && err.code !== 'ENOENT') {
        console.error(`Failed to delete uploaded file ${filePath}:`, err);
      }
    });
  };

  const ffmpeg = spawn(commandToRun, {
    shell: true,
  });

  if (!ffmpeg.stdout || !ffmpeg.stderr) {
    cleanupUploadedFile();
    res.status(500).json({
      error: 'Failed to start transcoding process.',
    });
    return;
  }

  let ffmpegError = '';

  ffmpeg.stderr.on('data', (chunk) => {
    ffmpegError += chunk.toString();
  });

  ffmpeg.on('error', (err) => {
    ffmpegError += err.message;
    cleanupUploadedFile();
    if (!res.headersSent) {
      res.status(500).json({
        error: 'Failed to start transcoding process.',
        details: err.message,
      });
      return;
    }

    res.destroy(err);
  });

  res.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `attachment; filename="${attachmentFileName}"`,
    'Transfer-Encoding': 'chunked',
  });

  ffmpeg.stdout.pipe(res);

  res.on('close', () => {
    ffmpeg.kill('SIGTERM');
  });

  ffmpeg.on('close', (code) => {
    cleanupUploadedFile();
    if (code !== 0 && !res.writableEnded) {
      const message = ffmpegError.trim() || `ffmpeg exited with code ${code}`;
      res.destroy(new Error(message));
    }
  });
});

if (require.main === module) {
  const server = app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
  });
  // Set timeouts to 15 minutes (600,000 ms) so Node waits for the full upload
  server.headersTimeout = 900000;
  server.requestTimeout = 900000;// Set timeouts to 15 minutes (900,000 ms) so Node waits for the full upload
  server.headersTimeout = 900000;
  server.requestTimeout = 900000;
}

export { app };

