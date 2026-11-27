import type {
  AudioBufferLike,
  AudioBufferSourceNodeLike,
  AudioContextLike,
  AudioNodeLike,
  AudioParamLike,
  BiquadFilterNodeLike,
  GainNodeLike,
  OscillatorNodeLike,
} from "../src/platform";

export type ParamEvent = [kind: "set" | "linear" | "exponential" | "cancel", value: number, time: number];

export class FakeParam implements AudioParamLike {
  value: number;
  events: ParamEvent[] = [];
  constructor(value: number) {
    this.value = value;
  }
  setValueAtTime(value: number, time: number): void {
    this.events.push(["set", value, time]);
  }
  linearRampToValueAtTime(value: number, time: number): void {
    this.events.push(["linear", value, time]);
  }
  exponentialRampToValueAtTime(value: number, time: number): void {
    this.events.push(["exponential", value, time]);
  }
  cancelScheduledValues(time: number): void {
    this.events.push(["cancel", 0, time]);
  }
}

export class FakeNode implements AudioNodeLike {
  readonly kind: string;
  outputs: FakeNode[] = [];
  disconnected = false;
  constructor(kind: string) {
    this.kind = kind;
  }
  connect(destination: AudioNodeLike): AudioNodeLike {
    this.outputs.push(destination as FakeNode);
    return destination;
  }
  disconnect(): void {
    this.disconnected = true;
  }
}

export class FakeGain extends FakeNode implements GainNodeLike {
  readonly gain = new FakeParam(1);
  constructor() {
    super("gain");
  }
}

export class FakeOscillator extends FakeNode implements OscillatorNodeLike {
  type = "sine";
  readonly frequency = new FakeParam(440);
  wave: object | undefined;
  startAt = Number.NaN;
  stopAt: number | undefined;
  constructor(private readonly context: FakeContext) {
    super("oscillator");
  }
  setPeriodicWave(wave: object): void {
    this.wave = wave;
    this.type = "custom";
  }
  start(when: number): void {
    this.startAt = when;
    this.context.started.push(this);
  }
  stop(when: number): void {
    this.stopAt = when;
  }
  get freq(): number {
    return this.frequency.events.find((event) => event[0] === "set")?.[1] ?? Number.NaN;
  }
}

export class FakeFilter extends FakeNode implements BiquadFilterNodeLike {
  type = "lowpass";
  readonly frequency = new FakeParam(350);
  readonly Q = new FakeParam(1);
  constructor() {
    super("filter");
  }
}

export class FakeSource extends FakeNode implements AudioBufferSourceNodeLike {
  buffer: AudioBufferLike | null = null;
  loop = false;
  startAt = Number.NaN;
  offset: number | undefined;
  stopAt: number | undefined;
  constructor(private readonly context: FakeContext) {
    super("source");
  }
  start(when: number, offset: number): void {
    this.startAt = when;
    this.offset = offset;
    this.context.started.push(this);
  }
  stop(when: number): void {
    this.stopAt = when;
  }
}

export class FakeContext implements AudioContextLike {
  currentTime = 0;
  readonly sampleRate = 100;
  readonly destination = new FakeNode("destination");
  started: (FakeOscillator | FakeSource)[] = [];
  gains: FakeGain[] = [];
  filters: FakeFilter[] = [];
  buffers = 0;
  waves = 0;
  createGain(): FakeGain {
    const node = new FakeGain();
    this.gains.push(node);
    return node;
  }
  createOscillator(): FakeOscillator {
    return new FakeOscillator(this);
  }
  createBiquadFilter(): FakeFilter {
    const node = new FakeFilter();
    this.filters.push(node);
    return node;
  }
  createBuffer(_channels: number, length: number): AudioBufferLike {
    this.buffers += 1;
    const data = new Float32Array(length);
    return { getChannelData: () => data };
  }
  createBufferSource(): FakeSource {
    return new FakeSource(this);
  }
  createPeriodicWave(): object {
    this.waves += 1;
    return { periodic: true };
  }
  outs(): FakeGain[] {
    return this.gains.filter((gain) => gain.outputs.includes(this.destination));
  }
  oscillators(): FakeOscillator[] {
    return this.started.filter((node): node is FakeOscillator => node instanceof FakeOscillator);
  }
}
