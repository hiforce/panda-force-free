import { createAppFixture } from './app-fixture.mjs';
import { createConnection, createServer } from 'node:net';

const root = new URL('..', import.meta.url).pathname;





function rawRequest(port, request) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let response = '';
    socket.setEncoding('utf8');
    socket.setTimeout(10_000, () => socket.destroy(new Error('Raw request timed out')));
    socket.on('connect', () => socket.write(request));
    socket.on('data', chunk => { response += chunk; });
    socket.on('end', () => resolve(response));
    socket.on('error', reject);
  });
}

const fixture=await createAppFixture();
const port=Number(new URL(fixture.base).port);

try {

  const target = '//[';
  const malformed = await rawRequest(port, `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
  const boundary=malformed.indexOf('\r\n\r\n');
  const headers=malformed.slice(0,boundary);let body=malformed.slice(boundary+4);
  if(/transfer-encoding:\s*chunked/i.test(headers)) {
    let remaining=body,decoded='';
    while(remaining){const line=remaining.indexOf('\r\n'),length=Number.parseInt(remaining.slice(0,line),16);if(!Number.isFinite(length))throw new Error('Invalid HTTP chunk');if(!length)break;decoded+=remaining.slice(line+2,line+2+length);remaining=remaining.slice(line+2+length+2)}
    body=decoded;
  }
  const health = await fetch(`http://127.0.0.1:${port}/api/health`,{headers:fixture.headers});
  const result = { statusLine: headers.split('\r\n')[0], contentType: /\r\ncontent-type: ([^\r\n]+)/i.exec(headers)?.[1], noStore: /\r\ncache-control: no-store\b/i.test(headers), nosniff: /\r\nx-content-type-options: nosniff\b/i.test(headers), body: body.trim(), health: health.status, exitCode: null };
  console.log(JSON.stringify(result, null, 2));
  if (!/^HTTP\/1\.1 400\b/.test(result.statusLine) || !/^application\/json; charset=utf-8$/i.test(result.contentType || '') || !result.noStore || !result.nosniff || result.body !== '{"error":"Invalid request URL"}' || result.health !== 200 || result.exitCode !== null) process.exitCode = 1;
} finally {
  await fixture.dispose();
}
