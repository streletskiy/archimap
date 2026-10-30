import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { setTimeout, clearTimeout } from 'node:timers';

const settings = JSON.parse(readFileSync(process.argv[2], 'utf8').replace(/^\uFEFF/, ''));
const connection = JSON.parse(readFileSync(settings.connectionFile, 'utf8').replace(/^\uFEFF/, ''));
const root = path.resolve(settings.destination);
mkdirSync(root, { recursive: true });
const env = { ...process.env, NODE_PATH: settings.modulePath,
  MESHCTRL_URL: connection.url.replace(/^https:/, 'wss:').replace(/\/control\.ashx$/, '/'),
  MESHCTRL_LOGINUSER: connection.username, MESHCTRL_LOGINPASS: connection.password,
  MESHCTRL_TOKEN: connection.token, MESHCTRL_LOGINKEY: connection.loginToken };
for (const key of Object.keys(env)) if (key.startsWith('MESHCTRL_') && !env[key]) delete env[key];
async function download(remote, local) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [settings.meshctrl, 'download', '--id', settings.nodeId,
      '--file', remote, '--target', local], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let complete = false;
    let tail = '';
    const timeout = setTimeout(() => child.kill(), 3 * 3600000);
    child.stdout.on('data', (data) => { tail = (tail + String(data)).slice(-512); if (tail.includes('Download completed,')) complete = true; });
    // Never echo authentication or server messages into a scheduled-task log.
    child.stderr.on('data', () => {});
    child.on('error', (error) => { clearTimeout(timeout); reject(error); });
    child.on('exit', (code) => { clearTimeout(timeout); return code === 0 && complete ? resolve() : reject(new Error('Backup transfer failed')); });
  });
}
async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex').toUpperCase();
}
await download(`${settings.remoteRoot}\\latest.json`, path.join(root, 'remote-latest.json'));
const manifest = JSON.parse(readFileSync(path.join(root, 'remote-latest.json'), 'utf8').replace(/^\uFEFF/, ''));
if (!/^archimap-\d{8}-\d{6}\.dump$/.test(manifest.file) || !/^[A-Fa-f0-9]{64}$/.test(manifest.sha256)
  || !Number.isSafeInteger(manifest.bytes) || manifest.bytes <= 0) throw new Error('Invalid backup manifest');
if (Date.now() - Date.parse(manifest.createdUtc) > 48 * 3600000 || !Number.isFinite(Date.parse(manifest.createdUtc))) throw new Error('Remote backup is older than 48 hours');
const target = path.join(root, manifest.file);
if (!existsSync(target) || statSync(target).size !== manifest.bytes || await hashFile(target) !== manifest.sha256.toUpperCase()) {
  const partial = `${target}.partial`;
  await download(`${settings.remoteRoot}\\${manifest.file}`, partial);
  if (statSync(partial).size !== manifest.bytes || await hashFile(partial) !== manifest.sha256.toUpperCase()) throw new Error('Backup checksum mismatch');
  renameSync(partial, target);
}
for (const item of manifest.configuration || []) {
  if (!/^archimap-\d{8}-\d{6}\.(env|compose\.yml)$/.test(item.file) || !/^[A-Fa-f0-9]{64}$/.test(item.sha256)
    || !Number.isSafeInteger(item.bytes) || item.bytes <= 0) throw new Error('Invalid configuration manifest');
  const configTarget = path.join(root, item.file);
  await download(`${settings.remoteRoot}\\${item.file}`, `${configTarget}.partial`);
  if (statSync(`${configTarget}.partial`).size !== item.bytes || await hashFile(`${configTarget}.partial`) !== item.sha256.toUpperCase()) throw new Error('Configuration checksum mismatch');
  renameSync(`${configTarget}.partial`, configTarget);
}
writeFileSync(path.join(root, 'latest.json'), JSON.stringify({ ...manifest, verifiedUtc: new Date().toISOString() }));
for (const name of readdirSync(root)) {
  if (!/^archimap-\d{8}-\d{6}\.(dump|env|compose\.yml)$/.test(name) || name === manifest.file || (manifest.configuration || []).some((item) => item.file === name)) continue;
  const candidate = path.join(root, name);
  if (statSync(candidate).mtimeMs < Date.now() - 3 * 86400000) unlinkSync(candidate);
}
console.log(JSON.stringify({ ok: true, bytes: manifest.bytes, createdUtc: manifest.createdUtc }));
