import { expect, test, type Page } from "@playwright/test";
import { canCreateAdmins, removeTestData } from "./accounts";
import { game, soloPlayer } from "./solo";

test.skip(!canCreateAdmins(), "needs GAMEHEARTH_ADMIN_LINK_COMMAND against an external server");
test.skip(process.env["GAMEHEARTH_URL"] !== undefined, "the test game Sammler only exists on the test server");
test.afterAll(async ({ baseURL }) => removeTestData(baseURL));

interface Scheduled {
  type: string;
  freq: number;
}

interface Ramp {
  value: number;
  time: number;
  at: number;
}

async function fakeAudio(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const scope = window as unknown as { AudioContext: unknown; __notes: Scheduled[]; __ramps: Ramp[] };
    scope.__notes = [];
    scope.__ramps = [];
    class Param {
      value = 1;
      first: number | undefined;
      constructor(private readonly context: FakeAudioContext, private readonly ramps: Ramp[] | undefined) {}
      setValueAtTime(value: number) {
        this.first ??= value;
      }
      linearRampToValueAtTime(value: number, time: number) {
        this.ramps?.push({ value, time, at: this.context.currentTime });
      }
      exponentialRampToValueAtTime() {
        return undefined;
      }
      cancelScheduledValues() {
        return undefined;
      }
    }
    class Node {
      connect(destination: unknown) {
        return destination;
      }
      disconnect() {
        return undefined;
      }
    }
    class FakeAudioContext {
      state = "suspended";
      sampleRate = 8000;
      destination = new Node();
      private base = 0;
      private since = 0;
      get currentTime(): number {
        return this.state === "running" ? this.base + (performance.now() - this.since) / 1000 : this.base;
      }
      async resume() {
        if (this.state !== "running") {
          this.since = performance.now();
          this.state = "running";
        }
      }
      createGain() {
        return Object.assign(new Node(), { gain: new Param(this, scope.__ramps) });
      }
      createOscillator() {
        const frequency = new Param(this, undefined);
        const oscillator = Object.assign(new Node(), {
          type: "square",
          frequency,
          setPeriodicWave: () => undefined,
          start: () => scope.__notes.push({ type: oscillator.type, freq: frequency.first ?? 0 }),
          stop: () => undefined,
        });
        return oscillator;
      }
      createBiquadFilter() {
        return Object.assign(new Node(), { type: "lowpass", frequency: new Param(this, undefined), Q: new Param(this, undefined) });
      }
      createBuffer(_channels: number, length: number) {
        const data = new Float32Array(length);
        return { getChannelData: () => data };
      }
      createBufferSource() {
        return Object.assign(new Node(), { buffer: null, loop: false, start: () => undefined, stop: () => undefined });
      }
      createPeriodicWave() {
        return {};
      }
      createDynamicsCompressor() {
        return Object.assign(new Node(), {
          threshold: new Param(this, undefined),
          knee: new Param(this, undefined),
          ratio: new Param(this, undefined),
          attack: new Param(this, undefined),
          release: new Param(this, undefined),
        });
      }
    }
    scope.AudioContext = FakeAudioContext;
  });
}

function notes(page: Page, type: "sine" | "sawtooth"): Promise<number> {
  return page.evaluate((wanted) => (window as unknown as { __notes: Scheduled[] }).__notes.filter((note) => note.type === wanted).length, type);
}

function fades(page: Page): Promise<{ out: number[]; in: number[] }> {
  return page.evaluate(() => {
    const ramps = (window as unknown as { __ramps: Ramp[] }).__ramps;
    const length = (ramp: Ramp) => Math.round((ramp.time - ramp.at) * 100) / 100;
    return { out: ramps.filter((ramp) => ramp.value === 0).map(length), in: ramps.filter((ramp) => ramp.value === 1).map(length) };
  });
}

async function setHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((value) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (value ? "hidden" : "visible") });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
}

async function steady(page: Page, type: "sine" | "sawtooth"): Promise<number> {
  await page.waitForTimeout(1600);
  const count = await notes(page, type);
  await page.waitForTimeout(1200);
  expect(await notes(page, type)).toBe(count);
  return count;
}

async function toggle(page: Page, name: "Ton" | "Musik"): Promise<void> {
  await page.getByRole("button", { name: "Menü" }).click();
  await page.getByRole("menuitemcheckbox", { name }).click();
}

test("music plays with sound and music on, stops with the music switch, crossfades, pauses while hidden and stays silent with sound off", async ({ browser }) => {
  const { page } = await soloPlayer(browser, "Mira");
  await fakeAudio(page);
  await page.goto("/play/sammler");
  const frame = game(page);
  await expect(frame.getByTestId("status")).toHaveText("neu");
  await expect(frame.getByTestId("music")).toHaveText("Musik: aus");

  await frame.getByTestId("music-a").click();
  await page.waitForTimeout(1200);
  expect(await notes(page, "sine")).toBe(0);

  await page.getByRole("button", { name: "Menü" }).click();
  await expect(page.getByRole("menuitemcheckbox", { name: "Musik" })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("menuitemcheckbox", { name: "Ton" }).click();
  await expect(frame.getByTestId("music")).toHaveText("Musik: an");
  await expect.poll(() => notes(page, "sine")).toBeGreaterThan(3);

  await frame.getByTestId("music-b").click();
  await expect.poll(() => notes(page, "sawtooth")).toBeGreaterThan(0);
  const sine = await steady(page, "sine");
  const crossfade = await fades(page);
  expect(crossfade.out).toContain(1);
  expect(crossfade.in).toContain(1.05);
  await frame.getByTestId("music-b").click();
  expect((await fades(page)).in).toHaveLength(crossfade.in.length);

  await setHidden(page, true);
  const hidden = await steady(page, "sawtooth");
  await setHidden(page, false);
  await expect.poll(() => notes(page, "sawtooth")).toBeGreaterThan(hidden);

  await toggle(page, "Musik");
  await expect(frame.getByTestId("music")).toHaveText("Musik: aus");
  expect(await page.evaluate(() => localStorage.getItem("gamehearth.music"))).toBe("off");
  const off = await steady(page, "sawtooth");
  await toggle(page, "Musik");
  await expect(frame.getByTestId("music")).toHaveText("Musik: an");
  await expect.poll(() => notes(page, "sawtooth")).toBeGreaterThan(off);

  await toggle(page, "Ton");
  await expect(frame.getByTestId("music")).toHaveText("Musik: aus");
  await steady(page, "sawtooth");
  expect(await notes(page, "sine")).toBe(sine);
});
