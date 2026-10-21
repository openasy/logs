// Fetches the pinned VictoriaLogs release into vendor/ and checks it against the checksum kept here (ADR 0027,
// 0035). Tests run against it, and the image is built with the same script, so they use the same binary.
//
//   node scripts/victorialogs.ts                 # this machine, into vendor/victoria-logs
//   node scripts/victorialogs.ts linux arm64 out  # another platform, into out/victoria-logs
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const VERSION = "v1.53.0";
/** sha256 of each release archive, from victoria-logs-<platform>-<version>_checksums.txt. Change with VERSION. */
const SHA256: Record<string, string> = {
  "linux-amd64": "55feba89713cafa952673f91b8b38e7701bb0290989263da671b47a0de16edd3",
  "linux-arm64": "301b7ef12ff9fac7f70b155191affe07ac6212755514174461d775548699ef96",
  "darwin-arm64": "e73406db1d291c8de66b2d63d2c6f7b25bc8c556e5b021e2f4dc04003381ce98",
};

const ARCH: Record<string, string> = { x64: "amd64", arm64: "arm64" };
const [os = process.platform, arch = ARCH[process.arch] ?? process.arch, outDir = new URL("../vendor", import.meta.url).pathname] = process.argv.slice(2);
const platform = `${os}-${arch}`;
const binary = join(outDir, "victoria-logs");
const stamp = join(outDir, "victoria-logs.version");

if (existsSync(binary) && existsSync(stamp) && readFileSync(stamp, "utf8").trim() === `${VERSION} ${platform}`) process.exit(0);
const sum = SHA256[platform];
if (!sum) {
  console.error(`No pinned checksum for VictoriaLogs ${VERSION} on ${platform}. Add it to scripts/victorialogs.ts.`);
  process.exit(1);
}
const name = `victoria-logs-${platform}-${VERSION}.tar.gz`;
const res = await fetch(`https://github.com/VictoriaMetrics/VictoriaLogs/releases/download/${VERSION}/${name}`);
if (!res.ok) throw new Error(`${name}: ${res.status}`);
const archive = Buffer.from(await res.arrayBuffer());
const got = createHash("sha256").update(archive).digest("hex");
if (got !== sum) throw new Error(`${name}: sha256 is ${got}, expected ${sum}`);

const dir = mkdtempSync(join(tmpdir(), "victoria-logs-"));
try {
  writeFileSync(join(dir, name), archive);
  execFileSync("tar", ["-xzf", join(dir, name), "-C", dir]);
  mkdirSync(outDir, { recursive: true });
  copyFileSync(join(dir, "victoria-logs-prod"), binary);
  chmodSync(binary, 0o755);
  writeFileSync(stamp, `${VERSION} ${platform}\n`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`VictoriaLogs ${VERSION} for ${platform} in ${binary}`);
