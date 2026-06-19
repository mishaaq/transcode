import fs, { PathLike } from 'fs';

function deleteFile(filePath: PathLike): void {
  fs.unlink(filePath, (err) => {
    if (err && err.code !== 'ENOENT') {
      console.error(`Failed to delete file ${filePath}:`, err);
    }
  });
};

export { deleteFile };