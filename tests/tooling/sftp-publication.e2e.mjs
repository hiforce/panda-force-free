import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { utils } from "ssh2";
import { SftpFileFactory } from "../../src/server/remote-files/sftp.ts";
import { SftpSites } from "../../src/server/remote-files/site.ts";
import { SftpSiteDelivery } from "../../src/server/delivery/adapters/sftp-site.ts";
import { sftpCredential } from "../../src/server/connections/adapters/sftp-input.ts";
import { digest } from "../../src/server/delivery/validation.ts";

if (process.env.PANDA_FORCE_TOOLING_TESTS !== "1") throw Error("Run with PANDA_FORCE_TOOLING_TESTS=1");
if (process.getuid?.() !== 0) throw Error("This isolated OpenSSH chroot fixture requires root");
// OpenSSH refuses a chroot below a world-writable ancestor such as /tmp.
const root = mkdtempSync("/root/panda-sftp-test-");
let daemon;
const run = (args) => {
  if (Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" }).exitCode)
    throw Error("Fixture command failed: " + args[0]);
};
const listener = createServer();
await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
try {
  for (const name of ["host", "client"])
    run([
      "ssh-keygen",
      "-q",
      "-t",
      "ed25519",
      "-N",
      name === "client" ? "disposable-key-passphrase" : "",
      "-f",
      join(root, name),
    ]);
  mkdirSync(join(root, "jail"), { mode: 0o755 });
  writeFileSync(join(root, "authorized_keys"), readFileSync(join(root, "client.pub")), { mode: 0o600 });
  writeFileSync(
    join(root, "sshd_config"),
    [
      "Port " + port,
      "ListenAddress 127.0.0.1",
      "HostKey " + join(root, "host"),
      "PidFile " + join(root, "sshd.pid"),
      "AuthorizedKeysFile " + join(root, "authorized_keys"),
      "PermitRootLogin prohibit-password",
      "PubkeyAuthentication yes",
      "PasswordAuthentication no",
      "KbdInteractiveAuthentication no",
      "UsePAM no",
      "StrictModes no",
      "AllowUsers root",
      "AllowTcpForwarding no",
      "AllowAgentForwarding no",
      "X11Forwarding no",
      "PermitTunnel no",
      "ChrootDirectory " + join(root, "jail"),
      "ForceCommand internal-sftp",
      "Subsystem sftp internal-sftp",
      "LogLevel QUIET",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  run(["/usr/sbin/sshd", "-t", "-f", join(root, "sshd_config")]);
  daemon = Bun.spawn(["/usr/sbin/sshd", "-D", "-f", join(root, "sshd_config")], { stdout: "ignore", stderr: "pipe" });
  await Bun.sleep(250);
  const key = utils.parseKey(readFileSync(join(root, "host")));
  assert(!(key instanceof Error) && !Array.isArray(key));
  const connection = {
    id: randomUUID(),
    projectId: randomUUID(),
    connector: "sftp-site",
    name: "Disposable OpenSSH",
    host: "127.0.0.1",
    port,
    username: "root",
    hostKey: "SHA256:" + createHash("sha256").update(key.getPublicSSH()).digest("base64").replace(/=$/, ""),
    directory: "/website",
    publicUrl: "https://example.com/",
    version: 1,
    enabled: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const credential = sftpCredential({
    method: "privateKey",
    privateKey: readFileSync(join(root, "client"), "utf8"),
    passphrase: "disposable-key-passphrase",
  });
  assert.equal(credential.passphrase, undefined);
  assert.ok(
    !(utils.parseKey(credential.privateKey) instanceof Error),
    "Normalized keys must not need the original passphrase",
  );
  const factory = new SftpFileFactory(),
    sites = new SftpSites(factory);
  await assert.rejects(
    factory.connect({ ...connection, hostKey: "SHA256:" + "A".repeat(43) }, credential),
    /hostKeyMismatch/,
  );
  await assert.rejects(
    factory.connect(connection, { method: "password", password: "fixture-wrong" }),
    /authenticationFailed/,
  );
  const probe = await sites.connect(connection, credential);
  try {
    await probe.probe();
    assert.deepEqual(
      (await probe.files.list("/website")).map((entry) => entry.name),
      [".panda-site.json"],
    );
    await probe.files.symlink("website", "/linked");
    await probe.files.write("/website/bounded", new Uint8Array([1, 2, 3, 4]), 0o600);
    await assert.rejects(probe.files.read("/website/bounded", 3), /remoteLimit/);
    await assert.rejects(probe.files.write("/website/bounded", new Uint8Array([0]), 0o600), /operationFailed/);
    await probe.files.unlink("/website/bounded");
  } finally {
    probe.close();
  }
  const linked = await sites.connect({ ...connection, directory: "/linked/site" }, credential);
  try {
    await assert.rejects(linked.probe(), /invalidRemotePath/);
  } finally {
    linked.close();
  }
  const bytes = Buffer.from("<h1>Disposable SFTP publication</h1>");
  const artifact = {
    protocol: 1,
    files: [{ path: "index.html", data: bytes.toString("base64"), sha256: digest(bytes) }],
    bytes: bytes.length,
  };
  const adapter = new SftpSiteDelivery(() => sites.connect(connection, credential));
  const plan = { id: randomUUID(), connection, fingerprint: digest("fixture-plan"), servedPath: "/website/current" };
  const calls = [];
  const gate = {
    fence: 1,
    run: () => {
      throw Error("Local gate used for SFTP");
    },
    remote: async (_step, name, operation) => {
      calls.push(name);
      return operation();
    },
  };
  const receipt = await adapter.deliver(plan, artifact, gate);
  assert.equal(receipt.verification, "sftp-files");
  assert.equal(receipt.previousRelease, null);
  assert.equal(readFileSync(join(root, "jail/website/current/index.html"), "utf8"), bytes.toString());
  assert.deepEqual(await adapter.reconcile(plan, artifact), receipt);
  const second = { ...plan, id: randomUUID(), fingerprint: digest("second-plan") };
  assert.equal((await adapter.deliver(second, artifact, gate)).previousRelease, plan.id);
  assert.equal(calls.filter((name) => name === "activateRelease").length, 2);
  const runtimeImage = process.env.PANDA_FORCE_APP_TEST_IMAGE;
  if (runtimeImage) {
    const script = `
      import { SftpFileFactory } from './src/server/remote-files/sftp.ts';
      import { SftpSites } from './src/server/remote-files/site.ts';
      import { SftpSiteDelivery } from './src/server/delivery/adapters/sftp-site.ts';
      const { connection, credential, plan, artifact } = JSON.parse(await Bun.stdin.text());
      const sites = new SftpSites(new SftpFileFactory());
      const adapter = new SftpSiteDelivery(() => sites.connect(connection, credential));
      const receipt = await adapter.deliver(plan, artifact, {
        fence: 1, run: () => { throw Error('Unexpected local operation'); },
        remote: async (_step, _name, operation) => operation()
      });
      if (receipt.verification !== 'sftp-files') throw Error('Missing runtime receipt');
      console.log(JSON.stringify({ runtimeSftp: true, releaseId: receipt.releaseId }));
    `;
    const containerConnection = { ...connection, id: randomUUID(), directory: "/runtime-site" };
    const containerPlan = {
      ...plan,
      id: randomUUID(),
      connection: containerConnection,
      servedPath: "/runtime-site/current",
    };
    const child = Bun.spawn(
      [
        "docker",
        "run",
        "--rm",
        "--network",
        "host",
        "--pull",
        "never",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "-i",
        "--entrypoint",
        "bun",
        runtimeImage,
        "-e",
        script,
      ],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
    child.stdin.write(JSON.stringify({ connection: containerConnection, credential, plan: containerPlan, artifact }));
    await child.stdin.end();
    const [status, output, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    assert.equal(status, 0, "Runtime SFTP failed: " + error);
    assert.equal(JSON.parse(output).releaseId, containerPlan.id);
    assert.equal(readFileSync(join(root, "jail/runtime-site/current/index.html"), "utf8"), bytes.toString());
  }
  console.log(
    JSON.stringify({
      openssh: true,
      isolatedChroot: true,
      hostKeyPinning: true,
      authenticationRejection: true,
      exclusiveWrites: true,
      boundedReads: true,
      atomicActivation: true,
      verifiedReceipt: true,
      previousReleaseRetained: true,
      runtimeImageVerified: Boolean(runtimeImage),
    }),
  );
} finally {
  if (daemon) {
    daemon.kill();
    await daemon.exited;
  }
  rmSync(root, { recursive: true, force: true });
}
