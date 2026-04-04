const fs = require('node:fs');
const path = require('node:path');

function createRequestId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function writeIpcFile(dir, data) {
  const filename = `${createRequestId()}.json`;
  const filepath = path.join(dir, filename);
  const tempPath = `${filepath}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
    fs.renameSync(tempPath, filepath);
  } catch (err) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // ignore cleanup failure
    }
    throw new Error(
      `IPC 写入失败 (${dir}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return filename;
}

async function pollIpcResult(dir, data, resultFilePrefix, timeoutMs = 30_000) {
  const resultFileName = `${resultFilePrefix}_${data.requestId}.json`;
  const resultFilePath = path.join(dir, resultFileName);

  writeIpcFile(dir, data);

  const pollInterval = 500;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const raw = fs.readFileSync(resultFilePath, 'utf-8');
      fs.unlinkSync(resultFilePath);
      return JSON.parse(raw);
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        throw err;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  throw new Error(`Timeout waiting for IPC result (${timeoutMs / 1000}s)`);
}

module.exports = {
  createRequestId,
  pollIpcResult,
  writeIpcFile,
};
