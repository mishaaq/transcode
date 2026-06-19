import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { once } from 'events';
import { spawnSync } from 'child_process';
import { request } from 'undici';
import FormData from 'form-data';

import { app } from '../index.js';

const inputFixturePath = path.resolve(process.cwd(), 'test', 'fixture', 'input.mp4');

let server: ReturnType<typeof app.listen> | undefined;

test.before(async () => {
  server = app.listen(0);
  server.timeout = 30000;
  await once(server, 'listening');
});

test.after(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server?.closeAllConnections();
      server?.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }
});

test('POST /transcode streams transcoded bytes during processing', async () => {
  const buffer = fs.readFileSync(inputFixturePath);
  const address = server!.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const form = new FormData();
  form.append('file', buffer, {
    filename: 'input.mp4',
    contentType: 'video/mp4',
  });

  const response = await request(`${baseUrl}/transcode`, {
    method: 'POST',
    body: form,
    headers: form.getHeaders(),
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['content-type'], 'video/mp4');

  const responseBody = Buffer.from(await response.body.arrayBuffer());
  assert.ok(responseBody.length > 0);
  assert.ok(!responseBody.equals(buffer));
});

test('POST /transcode uses the original filename stem for the download attachment', async () => {
  const buffer = fs.readFileSync(inputFixturePath);
  const address = server!.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const form = new FormData();
  form.append('file', buffer, {
    filename: 'sample-video.mp4',
    contentType: 'video/mp4',
  });

  const response = await request(`${baseUrl}/transcode`, {
    method: 'POST',
    body: form,
    headers: form.getHeaders(),
  });

  assert.equal(response.statusCode, 200);
  assert.equal(
    response.headers['content-disposition'],
    'attachment; filename="sample-video-out.mp4"'
  );
});

test('POST /transcode preserves GPS and creation metadata when available', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcode-metadata-'));
  const sourcePath = path.join(tempDir, 'metadata-input.mp4');
  fs.copyFileSync(inputFixturePath, sourcePath);

  const exiftoolResult = spawnSync(
    'exiftool',
    [
      '-overwrite_original',
      '-GPSCoordinates=51.5,-0.1',
      '-CreateDate=2024:01:02 03:04:05',
      '-ModifyDate=2024:01:02 03:04:05',
      sourcePath,
    ],
    { encoding: 'utf8' }
  );

  assert.equal(exiftoolResult.status, 0, exiftoolResult.stderr || exiftoolResult.stdout);

  const address = server!.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const form = new FormData();
  form.append('file', fs.readFileSync(sourcePath), {
    filename: 'metadata-input.mp4',
    contentType: 'video/mp4',
  });

  const response = await request(`${baseUrl}/transcode`, {
    method: 'POST',
    body: form,
    headers: form.getHeaders(),
  });

  assert.equal(response.statusCode, 200);

  const responseBody = Buffer.from(await response.body.arrayBuffer());
  const outputPath = path.join(tempDir, 'metadata-output.mp4');
  fs.writeFileSync(outputPath, responseBody);

  const metadataResult = spawnSync(
    'exiftool',
    ['-j', '-n', outputPath],
    { encoding: 'utf8' }
  );

  assert.equal(metadataResult.status, 0, metadataResult.stderr || metadataResult.stdout);

  const metadata = JSON.parse(metadataResult.stdout);
  const tags = metadata[0] ?? {};

  assert.ok(Math.abs(Number(tags.GPSLatitude) - 51.5) < 0.001);
  assert.ok(Math.abs(Number(tags.GPSLongitude) + 0.1) < 0.001);
  assert.ok(
    String(tags.GPSCoordinates ?? '').includes('51.5') &&
      String(tags.GPSCoordinates ?? '').includes('-0.1')
  );
});

test('POST /transcode deletes the uploaded temp file after streaming finishes', async () => {
  const buffer = fs.readFileSync(inputFixturePath);
  const tempDir = os.tmpdir();
  const beforeFileCount = fs.readdirSync(tempDir).filter((name) => /^\d+-file\.mp4$/.test(name)).length;

  const address = server!.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const form = new FormData();
  form.append('file', buffer, {
    filename: 'input.mp4',
    contentType: 'video/mp4',
  });

  const response = await request(`${baseUrl}/transcode`, {
    method: 'POST',
    body: form,
    headers: form.getHeaders(),
  });

  assert.equal(response.statusCode, 200);
  const responseBody = Buffer.from(await response.body.arrayBuffer());
  assert.ok(responseBody.length > 0);

  const afterFileCount = fs.readdirSync(tempDir).filter((name) => /^\d+-file\.mp4$/.test(name)).length;

  assert.equal(afterFileCount, beforeFileCount);
});
