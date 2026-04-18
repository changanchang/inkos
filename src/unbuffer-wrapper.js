import fs from 'fs';
import { pathToFileURL } from 'url';

// Force stdout to be unbuffered by monkey-patching process.stdout.write to use fs.writeSync(1)
const originalWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, encoding, callback) => {
  try {
    if (typeof chunk === 'string') {
      fs.writeSync(1, Buffer.from(chunk, encoding || 'utf-8'));
    } else {
      fs.writeSync(1, chunk);
    }
    if (callback) callback();
    return true;
  } catch (e) {
    return originalWrite(chunk, encoding, callback);
  }
};

// Also patch console.log just in case it bypasses process.stdout.write internally in some node versions
const originalLog = console.log;
console.log = (...args) => {
  const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ') + '\n';
  fs.writeSync(1, Buffer.from(msg, 'utf-8'));
};

const scriptPath = process.argv[2];
// Remove our wrapper from argv so the target script sees the right arguments
process.argv.splice(1, 1);

// Convert to a file:// URL so Node ESM loader works on Windows (c:\ paths are not valid URLs)
const scriptUrl = pathToFileURL(scriptPath).href;

// Import the actual CLI entry point
import(scriptUrl).catch(err => {
    console.error("Failed to load script:", err);
    process.exit(1);
});
