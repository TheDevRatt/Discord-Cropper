declare module 'gifenc' {
  export type RGB = [number, number, number]
  export type RGBA = [number, number, number, number]
  export type Palette = RGB[] | RGBA[]
  export type PixelFormat = 'rgb565' | 'rgb444' | 'rgba4444'

  export interface QuantizeOptions {
    format?: PixelFormat
    clearAlpha?: boolean
    clearAlphaThreshold?: number
    clearAlphaColor?: number
    oneBitAlpha?: boolean | number
  }

  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    options?: QuantizeOptions,
  ): Palette

  export function applyPalette(
    rgba: Uint8Array | Uint8ClampedArray,
    palette: Palette,
    format?: PixelFormat,
  ): Uint8Array

  export function nearestColorIndex(
    palette: Palette,
    pixel: RGB | RGBA,
  ): number

  export interface FrameOptions {
    palette?: Palette
    delay?: number
    transparent?: boolean
    transparentIndex?: number
    dispose?: number
    repeat?: number
    first?: boolean
  }

  export interface Encoder {
    writeFrame(
      index: Uint8Array,
      width: number,
      height: number,
      options?: FrameOptions,
    ): void
    finish(): void
    bytes(): Uint8Array<ArrayBuffer>
    bytesView(): Uint8Array<ArrayBuffer>
    reset(): void
    readonly buffer: ArrayBuffer
  }

  export interface EncoderOptions {
    auto?: boolean
    initialCapacity?: number
  }

  export function GIFEncoder(options?: EncoderOptions): Encoder
}
