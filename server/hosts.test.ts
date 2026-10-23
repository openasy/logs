import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseHosts } from "./hosts.ts";
import { fingerprint } from "./logs.ts";
import { HOST_KEY, OTHER_KEY, startApp } from "./test-app.ts";

// The same file as in Infrastructure (ADR 0052): both products read the same entries.
const FIXTURE = readFileSync(new URL("./testdata/hosts.yaml", import.meta.url), "utf8");
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const json = async (res: Response) => (await res.json()) as any;

describe("the hosts file", () => {
  it("reads the same entries as Infrastructure does", () => {
    expect(parseHosts(FIXTURE).map((h) => `${h.name} ${h.address}:${h.port} ${h.user} ${h.jump ?? "-"} ${h.hostKey ?? "-"}`)).toEqual([
      "bastion 10.0.0.2:22 openasy - -",
      "web-1 10.0.0.5:22 openasy bastion SHA256:PDOhaQiW49e9hQXf81r2bgjWlUS0+xzcwzCeUeVWhZo",
      "db-1 10.0.0.6:2222 reader - -",
    ]);
    expect(() => parseHosts("hosts:\n  - { name: a, address: -oProxyCommand=sh }")).toThrow(/address is required/);
  });
});

describe("hosts from the file", () => {
  let app: Awaited<ReturnType<typeof startApp>>;
  let agent: Awaited<ReturnType<Awaited<ReturnType<typeof startApp>>["enroll"]>>;
  beforeAll(async () => {
    app = await startApp({ version });
  });
  afterAll(() => app.close());

  const hosts = async () => (await json(await app.admin("/api/v1/hosts"))).hosts as Array<Record<string, any>>;
  const host = async (name: string) => (await hosts()).find((h) => h.name === name)!;
  const DIRECT = "hosts:\n  - { name: bastion, address: 10.0.0.2, agent: dc1 }\n  - { name: web-1, address: 10.0.0.5, agent: dc1, hostKey: 'SHA256:PDOhaQiW49e9hQXf81r2bgjWlUS0+xzcwzCeUeVWhZo' }\n";

  it("wait for their agent, and leave out hosts behind a jump host", async () => {
    expect(app.logs.syncFile(parseHosts(FIXTURE))).toEqual([
      "bastion: no agent is named dc1; it is added once one is.",
      "web-1: Logs reaches hosts directly, not through a jump host like bastion; it is left out.",
      "db-1: no agent is named dc1; it is added once one is.",
    ]);
    agent = await app.enroll("dc1");
    expect(app.logs.syncFile(parseHosts(FIXTURE))).toEqual(["web-1: Logs reaches hosts directly, not through a jump host like bastion; it is left out."]);
    expect((await hosts()).map((h) => `${h.name} ${h.origin} ${h.agent.name} ${h.port} ${h.user}`)).toEqual(["bastion file dc1 22 openasy", "db-1 file dc1 2222 reader"]);
  });

  it("trust the key the file names, and only that one", async () => {
    expect(app.logs.syncFile(parseHosts(DIRECT))).toEqual([]);
    expect((await hosts()).map((h) => h.name)).toEqual(["bastion", "web-1"]);
    agent.hosts.set("10.0.0.2", { key: OTHER_KEY, lines: [] });
    agent.hosts.set("10.0.0.5", { key: HOST_KEY, lines: [] });
    await agent.round();
    expect(await host("bastion")).toMatchObject({ status: "host-key-pending", hostKeys: [], fileHostKey: null });
    expect(await host("web-1")).toMatchObject({ status: "pending", hostKeys: [{ fingerprint: fingerprint(HOST_KEY) }], fileHostKey: fingerprint(HOST_KEY) });

    app.logs.syncFile(parseHosts(DIRECT.replace("10.0.0.2, agent: dc1 }", `10.0.0.2, agent: dc1, hostKey: '${fingerprint(HOST_KEY)}' }`)));
    await agent.round();
    const bastion = await host("bastion");
    expect(bastion).toMatchObject({ status: "host-key-pending", statusDetail: expect.stringMatching(/not SHA256:.* from the hosts file/) });
    const refused = await app.admin(`/api/v1/hosts/${bastion.id}/host-key/accept`, { method: "POST", body: JSON.stringify({ fingerprint: fingerprint(OTHER_KEY) }) });
    expect(refused.status).toBe(409);
  });

  it("are changed in the file only, and a name taken here is left alone", async () => {
    const web = await host("web-1");
    expect((await app.admin(`/api/v1/hosts/${web.id}`, { method: "PATCH", body: JSON.stringify({ port: 2200 }) })).status).toBe(409);
    expect((await app.admin(`/api/v1/hosts/${web.id}`, { method: "DELETE" })).status).toBe(409);
    await app.admin("/api/v1/hosts", { method: "POST", body: JSON.stringify({ name: "mail-1", address: "10.0.0.9" }) });
    expect(app.logs.syncFile(parseHosts("hosts:\n  - { name: mail-1, address: 10.0.0.9, agent: dc1 }\n"))).toEqual(["mail-1: a host with this name was added in Logs; remove it there to let the file manage it."]);
    expect((await hosts()).map((h) => `${h.name} ${h.origin}`)).toEqual(["mail-1 ui"]);
  });
});

describe("the summary", () => {
  it("says where the file stands, or null without one", async () => {
    const state = { path: "/config/hosts.yaml", appliedAt: "2026-10-01T00:00:00.000Z", entries: 3, error: null, warnings: ["x"] };
    const withFile = await startApp({ version, hostsFile: () => state });
    try {
      expect((await json(await withFile.admin("/api/v1/summary"))).hostsFile).toEqual(state);
    } finally {
      await withFile.close();
    }
  });
});
