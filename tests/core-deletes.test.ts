import { describe, expect, it } from "vitest";
import { world } from "./harness";

async function vault(count: number) {
  const w = world();
  for (let i = 0; i < count; i++) w.mac.local.put(`n${String(i).padStart(3, "0")}.md`, `note ${i}`);
  await w.mac.syncOk();
  await w.phone.syncOk();
  return w;
}

describe("deletes", () => {
  it("propagates a local delete to Drive trash and then to the other device", async () => {
    const { mac, phone, remote } = await vault(10);
    const id = remote.byPath("n003.md")!.meta.id;
    await mac.local.delete("n003.md");

    await mac.syncOk();

    expect(remote.byPath("n003.md")).toBeUndefined();
    expect(remote.trashed.has(id)).toBe(true);
    expect(mac.manifest.get("n003.md")).toBeUndefined();

    await phone.syncOk();
    expect(phone.local.files.has("n003.md")).toBe(false);
    expect(phone.local.files.size).toBe(9);
  });

  it("restores a file deleted locally but edited on the other device", async () => {
    const { mac, phone } = await vault(10);
    phone.local.put("n001.md", "edited on phone");
    await phone.syncOk();
    await mac.local.delete("n001.md");

    await mac.syncOk();

    expect(mac.local.text("n001.md")).toBe("edited on phone");
  });

  it("re-uploads a file edited locally but deleted on the other device", async () => {
    const { mac, phone, remote } = await vault(10);
    await phone.local.delete("n001.md");
    await phone.syncOk();
    mac.local.put("n001.md", "edited on mac");

    await mac.syncOk();

    expect(remote.text("n001.md")).toBe("edited on mac");
    await phone.syncOk();
    expect(phone.local.text("n001.md")).toBe("edited on mac");
  });

  it("pauses when deleting more than 20% of the vault, then proceeds once confirmed", async () => {
    const { mac, remote } = await vault(10);
    for (const p of ["n000.md", "n001.md", "n002.md"]) await mac.local.delete(p);

    const paused = await mac.sync();

    expect(paused).toMatchObject({ status: "needsConfirmation", reason: "massDelete" });
    expect(paused.summary.deleteRemote).toEqual(["n000.md", "n001.md", "n002.md"]);
    expect(remote.paths()).toHaveLength(10);

    await mac.syncOk({ confirmDeletes: true });
    expect(remote.paths()).toHaveLength(7);
  });

  it("pauses on more than 50 deletes even in a large vault", async () => {
    const { mac, phone } = await vault(300);
    for (let i = 0; i < 51; i++) await mac.local.delete(`n${String(i).padStart(3, "0")}.md`);
    await mac.syncOk({ confirmDeletes: true });

    const paused = await phone.sync();

    expect(paused).toMatchObject({ status: "needsConfirmation", reason: "massDelete" });
    expect(paused.summary.deleteLocal).toHaveLength(51);
    expect(phone.local.files.size).toBe(300);
  });

  it("does not pause at the threshold", async () => {
    const { mac } = await vault(10);
    for (const p of ["n000.md", "n001.md"]) await mac.local.delete(p);
    expect((await mac.sync()).status).toBe("synced");
  });
});
