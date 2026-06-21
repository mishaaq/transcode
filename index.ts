import express, { Request, Response } from 'express';
import fs, { PathLike } from 'fs';
import busboy from 'busboy';
import path from 'path';
import { spawn } from 'child_process';
import { deleteFile } from './utils';

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.BIND || 'localhost';

type SuccessCallback = [outputFilePath: PathLike, error: null];
type ErrorCallback = [outputFilePath: null, error: Error];

type TranscodeCallback = (...args: SuccessCallback | ErrorCallback) => void;

const WORK_DIR = path.join(process.cwd(), 'workdir');

if (!fs.existsSync(WORK_DIR)) {
  fs.mkdirSync(WORK_DIR, { recursive: true });
}

app.get('/', (_req: Request, res: Response) => {
  res.send('Transcode is running!');
});

app.post('/transcode', (req: Request, res: Response) => {
  const bb = busboy({ headers: req.headers, limits: { files: 1 } });
  let fileReceived = false;
  let fileSent = false;

  bb.on('file', (_name, fileStream, info) => {
    fileReceived = true;
    const { filename } = info;
    const inputFilePath = path.join(WORK_DIR, path.basename(filename));

    const writeStream = fs.createWriteStream(inputFilePath);
    fileStream.pipe(writeStream);

    writeStream.on('finish', async () => {
      console.debug(`File [${filename}] saved to temporary location.`);

      transcodeFile(inputFilePath, (outputFilePath, err) => {
        if (err) {
          console.error('Error during transcoding:', err);
          if (!res.headersSent) {
            res.status(500).json({
              error: 'Error processing file upload.',
              details: err instanceof Error ? err.message : String(err),
            });
          } else {
            res.destroy(err instanceof Error ? err : new Error(String(err)));
          }
          deleteFile(inputFilePath);
          return;
        }
        console.debug(`Transcoding completed. Output file: ${outputFilePath}`);

        const stat = fs.statSync(outputFilePath);

        res.writeHead(200, {
          'Content-Type': 'video/mp4',
          'Content-Length': stat.size,
          'Cache-Control': 'no-cache',
          'X-Content-Type-Options': 'nosniff',
          'Content-Disposition': `attachment; filename="${path.basename(inputFilePath, path.extname(inputFilePath))}-out.mp4"`,
        })

        const readStream = fs.createReadStream(outputFilePath);
        readStream.pipe(res);

        readStream.on('error', (err) => {
          console.error('Error sending transcoded file:', err);
          if (!res.headersSent) {
            res.status(500).json({
              error: 'Error sending transcoded file.',
              details: err instanceof Error ? err.message : String(err),
            });
          } else {
            res.destroy(err instanceof Error ? err : new Error(String(err)));
          }
          deleteFile(inputFilePath);
          deleteFile(outputFilePath);
        });
        
        res.on('finish', () => {
          console.debug(`Finished sending transcoded file. Cleaning up temporary files.`);
          deleteFile(inputFilePath);
          deleteFile(outputFilePath);
          fileSent = true;
        });

        req.on('close', () => {
          if (!fileSent) {
            console.debug('Client disconnected before transcoded file was fully sent. Cleaning up temporary files.');
            deleteFile(inputFilePath);
            deleteFile(outputFilePath);
          }
        });
      });
    });

    fileStream.on('error', (err) => {
      console.error('Error receiving file stream:', err);
      if (!res.headersSent) {
        res.status(500).json({
          error: 'Error receiving file stream.',
          details: err instanceof Error ? err.message : String(err),
        });
      } else {
        res.destroy(err instanceof Error ? err : new Error(String(err)));
      }
      writeStream.end();
      deleteFile(inputFilePath);
    });

    writeStream.on('error', (err) => {
      console.error('Error writing file to disk:', err);
      if (!res.headersSent) {
        res.status(500).json({
          error: 'Error writing file to disk.',
          details: err instanceof Error ? err.message : String(err),
        });
      } else {
        res.destroy(err instanceof Error ? err : new Error(String(err)));
      }
    });

    req.on('close', () => {
      if (!fileReceived) {
        console.debug('Client disconnected before file upload completed. Cleaning up temporary files.');
        deleteFile(inputFilePath);
      }
    });
  });

  bb.on('error', (err) => {
    console.error('Error processing file upload:', err);
    if (!res.headersSent) {
      res.status(500).json({
        error: 'Error processing file upload.',
        details: err instanceof Error ? err.message : String(err),
      });
    } else {
      res.destroy(err instanceof Error ? err : new Error(String(err)));
    }
  });

  bb.on('filesLimit', () => {
    console.error('Too many files uploaded.');
    if (!res.headersSent) {
      res.status(400).json({
        error: 'Too many files uploaded. Only one file is allowed.',
      });
    } else {
      res.destroy(new Error('Too many files uploaded. Only one file is allowed.'));
    }
  });

  bb.on('close', () => {
    if (!fileReceived) {
      res.status(400).json({
        error: 'No file uploaded.',
      });
      return;
    }
  });

  req.pipe(bb);
});

function copyMetadata(inputFile: string, outputFile: string, callback: (err: Error | null) => void): void {
  const exiftool = spawn('exiftool', [
    '-overwrite_original',
    '-api',
    'LargeFileSupport=1',
    '-TagsFromFile',
    inputFile,
    '-all:all',
    outputFile,
  ]);

  exiftool.on('error', (err) => {
    callback(err);
  });

  exiftool.on('exit', (code) => {
    if (code !== 0) {
      callback(new Error(`exiftool exited with code ${code}`));
      return;
    }
    callback(null);
  });
}

function transcodeFile(filePath: string, callback: TranscodeCallback): void {
  const outputFile = filePath + '-transcoded.mp4';

  const ffmpeg = spawn('ffmpeg', [
    '-nostdin',
    '-hwaccel',
    'qsv',
    '-hwaccel_output_format',
    'qsv',
    '-i',
    filePath,
    '-vf',
    'vpp_qsv=format=p010',
    '-c:v',
    'hevc_qsv',
    '-profile:v',
    'main10',
    '-b:v',
    '0',
    '-global_quality',
    '24',
    '-c:a',
    'aac',
    '-tag:v',
    'hvc1',
    '-y',
    outputFile,
  ], { stdio: ['ignore', 'ignore', 'inherit']});

  ffmpeg.on('error', (err) => {
    callback(null, err);
  });

  ffmpeg.on('exit', (code) => {
    if (code !== 0) {
      console.error(`ffmpeg exited with code ${code}`);
      deleteFile(outputFile);
      callback(null, new Error(`ffmpeg exited with code ${code}`));
      return;
    }

    copyMetadata(filePath, outputFile, (err) => {
      if (err) {
        console.error('Error copying metadata:', err);
        deleteFile(outputFile);
        callback(null, err);
        return;
      }
      callback(outputFile, null);
    });
  });
};

if (require.main === module) {
  const server = app.listen(PORT, HOST, () => {
    console.log(`Server is running on http://${HOST}:${PORT}`);
  });
  // Set timeouts to 15 minutes (900,000 ms) so Node waits for the full upload
  server.headersTimeout = 900000;
  server.requestTimeout = 900000;
}

export { app };

