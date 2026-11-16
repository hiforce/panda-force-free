import { createServer, type TLSSocket } from "node:tls";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

/** A private TLS SMTP sink. It never connects to a real mail service. */
export async function smtpFixture() {
  const root = mkdtempSync(join(tmpdir(), "panda-smtp-")),
    key = join(root, "key.pem"),
    cert = join(root, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-days",
      "1",
    ],
    { stdio: "ignore" },
  );
  const messages: { to: string; source: string; html: string }[] = [],
    sockets = new Set<TLSSocket>();
  const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.write("220 fixture ready\r\n");
    let buffer = "",
      data = false,
      body = "",
      to = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      while (buffer.includes("\r\n")) {
        const i = buffer.indexOf("\r\n"),
          line = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        if (data) {
          if (line !== ".") {
            body += line + "\r\n";
            continue;
          }
          data = false;
          const mime = body.split("\r\n\r\n").slice(1).join("\r\n\r\n");
          messages.push({ to, source: body, html: Buffer.from(mime.replace(/\s/g, ""), "base64").toString("utf8") });
          body = "";
          socket.write("250 accepted\r\n");
          continue;
        }
        if (line.startsWith("EHLO")) socket.write("250-fixture\r\n250 AUTH PLAIN LOGIN\r\n");
        else if (line.startsWith("AUTH PLAIN")) socket.write("235 authenticated\r\n");
        else if (line.startsWith("MAIL FROM")) socket.write("250 ok\r\n");
        else if (line.startsWith("RCPT TO")) {
          to = line.slice(8);
          socket.write("250 ok\r\n");
        } else if (line === "DATA") {
          data = true;
          socket.write("354 go ahead\r\n");
        } else if (line === "QUIT") socket.end("221 bye\r\n");
        else socket.write("500 unknown\r\n");
      }
    });
  });
  server.on("tlsClientError", () => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    messages,
    config: {
      host: "127.0.0.1",
      port: (server.address() as { port: number }).port,
      security: "tls" as const,
      username: "smtp-test",
      password: "smtp-test-password",
      ca: readFileSync(cert, "utf8"),
      from: "panda@example.com",
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    },
  };
}
