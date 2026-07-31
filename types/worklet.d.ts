/**
 * Globals that exist inside AudioWorkletGlobalScope.
 *
 * TypeScript's DOM library covers the main thread only, so without these the two
 * files in src/audio/worklets/ report an error on nearly every line -- and the
 * genuine mistakes get lost in the noise.
 *
 * Declaring them globally means main-thread files can also see `sampleRate` and
 * friends, which is not strictly true. That is the accepted cost of not splitting
 * the project into two separate type-check roots for two files.
 */

declare const sampleRate: number;
declare const currentFrame: number;
declare const currentTime: number;

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}

declare function registerProcessor(
  name: string,
  processorCtor: new (options?: unknown) => AudioWorkletProcessor,
): void;
